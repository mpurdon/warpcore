"""The compiler: what a project asks AWS for."""

import json

import pytest
import yaml

from warpcore.config.parser import Config
from warpcore.orchestrator.compiler import compile_project, lift
from warpcore.orchestrator.refs import is_ref

ENV = {"dev": {"account": "123456789012", "region": "us-east-1", "logging": {"retention_days": 7, "xray": False},
               "defaults": {"lambda_memory": 256, "lambda_timeout": 20, "s3_versioning": False}}}


def _config(tmp_path, data):
    path = tmp_path / "warpcore.yaml"
    path.write_text(yaml.safe_dump(data))
    return Config(str(path)).load()


def _canvas(nodes, edges=()):
    return {
        "project": {"name": "shop", "region": "us-east-1"},
        "agents": [],
        "resources": [{"name": n["label"], "type": n["type"]} for n in nodes if n["type"] not in ("application", "band")],
        "environments": ENV,
        "canvas": {"nodes": [{"x": 0, "y": 0, **n} for n in nodes], "edges": list(edges)},
    }


def node(id, type, label=None, **config):
    return {"id": id, "type": type, "label": label or id, "config": config}


class TestFunctions:
    def test_a_function_gets_a_role_a_log_group_and_a_stub(self, tmp_path):
        (tmp_path / "src").mkdir()
        cfg = _config(tmp_path, _canvas([node("lambda-1", "lambda", "place-order", memory=512)]))
        out = compile_project(cfg, "dev")
        fn = out.resources["lambda-1"]
        assert fn.type == "AWS::Lambda::Function"
        assert fn.properties["FunctionName"] == "shop-dev-place-order"
        assert fn.properties["MemorySize"] == 512 and fn.properties["Timeout"] == 20
        assert is_ref(fn.properties["Role"]) and fn.properties["Role"]["$ref"] == "lambda-1-role"
        assert set(fn.dependencies) == {"lambda-1-role", "lambda-1-logs"}
        role = out.resources["lambda-1-role"]
        assert role.properties["RoleName"] == "shop-dev-place-order-role"
        assert role.properties["ManagedPolicyArns"] == []
        logs_stmt = role.properties["InlinePolicies"]["warpcore-logs"]["Statement"][0]
        assert logs_stmt["Resource"] == ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/shop-dev-place-order:*"]
        logs = out.resources["lambda-1-logs"]
        assert logs.properties == {"ResourceType": "LogGroup", "LogGroupName": "/aws/lambda/shop-dev-place-order", "RetentionInDays": 7}
        # No code path: a stub was written and the note says so.
        assert (tmp_path / ".warpcore" / "stubs" / "shop-dev-place-order" / "main.py").exists()
        assert any("stub handler" in n for n in out.notes)
        assert fn.metadata["managed"] is True

    def test_a_code_path_is_used_when_it_exists(self, tmp_path):
        (tmp_path / "functions" / "api").mkdir(parents=True)
        (tmp_path / "functions" / "api" / "main.py").write_text("def handler(e, c): return 1\n")
        cfg = _config(tmp_path, _canvas([node("lambda-1", "lambda", "api", path="functions/api", handler="main.handler")]))
        out = compile_project(cfg, "dev")
        assert out.resources["lambda-1"].properties["CodePath"] == str((tmp_path / "functions" / "api").resolve())
        assert not any("stub" in n for n in out.notes)

    def test_connections_become_policy_statements_and_links(self, tmp_path):
        nodes = [node("lambda-1", "lambda", "api"), node("dynamodb-1", "dynamodb", "orders", tableName="orders"),
                 node("s3-1", "s3", "uploads", bucketName="shop-uploads"), node("sqs-1", "sqs", "jobs", queueName="jobs")]
        edges = [
            {"id": "e1", "source": "lambda-1", "target": "dynamodb-1", "config": {"writeAccess": False}},
            {"id": "e2", "source": "lambda-1", "target": "s3-1", "config": {}},
            {"id": "e3", "source": "sqs-1", "target": "lambda-1", "config": {}},
        ]
        out = compile_project(_config(tmp_path, _canvas(nodes, edges)), "dev", write_stubs=False)
        stmts = out.resources["lambda-1-role"].properties["InlinePolicies"]["warpcore-access"]["Statement"]
        by_res = {tuple(s["Resource"]): s["Action"] for s in stmts}
        assert by_res[("arn:aws:dynamodb:us-east-1:123456789012:table/orders",)] == ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
        assert by_res[("arn:aws:s3:::shop-uploads", "arn:aws:s3:::shop-uploads/*")] == ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:DeleteObject"]
        assert by_res[("arn:aws:sqs:us-east-1:123456789012:jobs",)] == ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        env = out.resources["lambda-1"].properties["Environment"]
        assert env == {"WARPCORE_ORDERS": "orders", "WARPCORE_UPLOADS": "shop-uploads"}
        assert any("event source mapping itself is not created" in n for n in out.notes)


class TestOtherResources:
    def test_table_queue_topic_bucket(self, tmp_path):
        nodes = [
            node("dynamodb-1", "dynamodb", "orders", tableName="orders", partitionKey="orderId", sortKey="ts", sortKeyType="Number"),
            node("sqs-1", "sqs", "jobs", queueName="jobs", fifo=True, visibilityTimeout=45),
            node("sqs-2", "sqs", "dead", queueName="jobs-dlq"),
            node("sns-1", "sns", "events", topicName="events"),
            node("s3-1", "s3", "uploads", bucketName="shop-uploads", versioning=True),
        ]
        edges = [{"id": "d", "source": "sqs-1", "target": "sqs-2", "config": {"isDLQ": True, "maxRetries": 5}}]
        out = compile_project(_config(tmp_path, _canvas(nodes, edges)), "dev", write_stubs=False)
        table = out.resources["dynamodb-1"].properties
        assert table["KeySchema"] == [{"AttributeName": "orderId", "KeyType": "HASH"}, {"AttributeName": "ts", "KeyType": "RANGE"}]
        assert table["AttributeDefinitions"][1] == {"AttributeName": "ts", "AttributeType": "N"}
        q = out.resources["sqs-1"].properties
        assert q["QueueName"] == "jobs.fifo" and q["FifoQueue"] is True and q["VisibilityTimeout"] == 45
        assert q["RedrivePolicy"]["maxReceiveCount"] == 5 and q["RedrivePolicy"]["deadLetterTargetArn"] == {"$ref": "sqs-2", "$prop": "QueueArn"}
        assert out.resources["sqs-1"].dependencies == ["sqs-2"]
        assert out.resources["sns-1"].properties == {"TopicName": "events"}
        assert out.resources["s3-1"].properties["VersioningStatus"] == "Enabled"

    def test_an_api_routes_to_its_functions(self, tmp_path):
        nodes = [node("api-gateway-1", "api-gateway", "api", apiName="shop-api"), node("lambda-1", "lambda", "orders"),
                 node("api-route-1", "api-route", "GET /health", method="GET", path="/health"), node("lambda-2", "lambda", "health")]
        edges = [
            {"id": "e1", "source": "api-gateway-1", "target": "lambda-1", "config": {"method": "POST", "path": "/orders"}},
            {"id": "e2", "source": "api-gateway-1", "target": "api-route-1", "config": {}},
            {"id": "e3", "source": "api-route-1", "target": "lambda-2", "config": {}},
        ]
        out = compile_project(_config(tmp_path, _canvas(nodes, edges)), "dev", write_stubs=False)
        api = out.resources["api-gateway-1"]
        keys = {r["RouteKey"]: r["IntegrationUri"]["$ref"] for r in api.properties["Routes"]}
        assert keys == {"POST /orders": "lambda-1", "GET /health": "lambda-2"}
        assert api.dependencies == ["lambda-1", "lambda-2"]
        assert "api-route-1" not in out.resources  # a route is part of its API

    def test_an_api_with_no_function_is_left_out_with_a_reason(self, tmp_path):
        out = compile_project(_config(tmp_path, _canvas([node("api-gateway-1", "api-gateway", "api")])), "dev")
        assert "api-gateway-1" not in out.resources
        assert out.skipped == [{"id": "api-gateway-1", "type": "api-gateway", "reason": "no route to a function"}]


class TestWhatIsNotCompiled:
    def test_discovered_resources_are_observed_not_desired(self, tmp_path):
        nodes = [{"id": "ec2-1", "type": "ec2-instance", "label": "host", "arn": "arn:aws:ec2:us-east-1:1:instance/i-1", "config": {}},
                 {"id": "s3-1", "type": "s3", "label": "logs", "arn": "arn:aws:s3:::logs", "config": {"bucketName": "logs"}},
                 {"id": "s3-2", "type": "s3", "label": "taken", "arn": "arn:aws:s3:::taken", "config": {"bucketName": "taken"}, "meta": {"managed": True}}]
        out = compile_project(_config(tmp_path, _canvas(nodes)), "dev")
        assert set(out.resources) == {"s3-2"}
        reasons = {x["id"]: x["reason"] for x in out.skipped}
        assert "discovered" in reasons["s3-1"] and "discovered" in reasons["ec2-1"]

    def test_unprovisioned_types_are_named_in_the_skip(self, tmp_path):
        out = compile_project(_config(tmp_path, _canvas([node("step-functions-1", "step-functions", "flow"), node("application-x", "application", "tile")])), "dev")
        assert out.resources == {}
        assert out.skipped == [{"id": "step-functions-1", "type": "step-functions", "reason": "a type no provisioner builds yet"}]


class TestHandWrittenProjects:
    def test_agents_resources_and_connections_lift_into_the_same_shape(self, tmp_path):
        (tmp_path / "agents" / "api").mkdir(parents=True)
        (tmp_path / "agents" / "api" / "main.py").write_text("x = 1\n")
        data = {
            "project": {"name": "shop", "region": "us-east-1"},
            "agents": [{"name": "api-agent", "path": "./agents/api", "memory": 1024}],
            "resources": [{"name": "orders", "type": "dynamodb", "config": {"partitionKey": "id"}}],
            "connections": [{"from": "api-agent", "to": "orders"}],
            "environments": ENV,
        }
        nodes, edges = lift(_config(tmp_path, data))
        assert [(n.id, n.type) for n in nodes] == [("agent-api-agent", "agent"), ("dynamodb-orders", "dynamodb")]
        assert (edges[0].source, edges[0].target) == ("agent-api-agent", "dynamodb-orders")
        out = compile_project(_config(tmp_path, data), "dev")
        fn = out.resources["agent-api-agent"]
        assert fn.properties["FunctionName"] == "api-agent" and fn.properties["MemorySize"] == 1024
        assert fn.tags["warpcore:agent"] == "api-agent"
        assert out.resources["dynamodb-orders"].properties["TableName"] == "orders"
        stmt = out.resources["agent-api-agent-role"].properties["InlinePolicies"]["warpcore-access"]["Statement"][0]
        assert stmt["Resource"] == ["arn:aws:dynamodb:us-east-1:123456789012:table/orders"]
