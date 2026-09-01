"""Emitting a warpcore.yaml from a scanned account."""

import pytest
import yaml

from warpcore.agentic.scanner import ScannedState
from warpcore.config.parser import Config
from warpcore.discovery.config_emitter import ConfigEmitter, sanitize_agent_name
from warpcore.state.models import Resource


def _lambda(name, **props):
    return Resource(
        id=name,
        type="AWS::Lambda::Function",
        physical_id=f"arn:aws:lambda:us-east-1:123456789012:function:{name}",
        properties={"FunctionName": name, "Runtime": "python3.11",
                    "MemorySize": 512, "Timeout": 30, "Handler": "main.handler", **props},
    )


def _scanned(*resources):
    state = ScannedState()
    for resource in resources:
        state.add_resource(resource)
    return state


def _emit(*resources, project="demo", environment="dev"):
    return ConfigEmitter(
        scanned_state=_scanned(*resources),
        project_name=project,
        environment=environment,
        account="123456789012",
        region="us-east-1",
    ).emit()


class TestSanitizeAgentName:
    @pytest.mark.parametrize("raw,expected", [
        ("my-agent", "my-agent"),
        ("MyAgent", "myagent"),
        ("my_agent_v2", "my-agent-v2"),
        ("Agent__X", "agent-x"),
        ("123-func", "func"),
    ])
    def test_coerces_to_schema(self, raw, expected):
        assert sanitize_agent_name(raw) == expected

    def test_returns_none_when_nothing_salvageable(self):
        assert sanitize_agent_name("___") is None
        assert sanitize_agent_name("999") is None


class TestEmit:
    def test_lambda_becomes_an_agent(self):
        result = _emit(_lambda("my-agent"))
        assert result.agent_count == 1
        agent = result.config["agents"][0]
        assert agent["name"] == "my-agent"
        assert agent["runtime"] == "python3.11"
        assert agent["memory"] == 512
        assert agent["timeout"] == 30

    def test_other_resources_become_resource_entries(self):
        bucket = Resource(
            id="data", type="AWS::S3::Bucket", physical_id="arn:aws:s3:::data",
            properties={"BucketName": "data", "Versioning": "Enabled"},
        )
        result = _emit(bucket)
        assert result.resource_count == 1
        entry = result.config["resources"][0]
        assert entry["type"] == "s3"
        assert entry["config"]["versioning"] is True
        assert entry["arn"] == "arn:aws:s3:::data"

    def test_environment_block_carries_account_and_region(self):
        result = _emit(_lambda("a"), environment="prod")
        assert result.config["environments"]["prod"] == {
            "account": "123456789012", "region": "us-east-1"
        }

    def test_unsupported_runtime_is_flagged_not_emitted(self):
        result = _emit(_lambda("node-fn", Runtime="nodejs20.x"))
        agent = result.config["agents"][0]
        assert "runtime" not in agent
        assert any("nodejs20.x" in n.message for n in result.warnings())

    def test_renamed_function_is_flagged_as_not_adopting(self):
        result = _emit(_lambda("My_Function"))
        assert result.config["agents"][0]["name"] == "my-function"
        assert any("NEW function" in n.message for n in result.warnings())

    def test_unnameable_function_is_skipped_with_a_warning(self):
        result = _emit(_lambda("___"))
        assert result.agent_count == 0
        assert result.skipped_count == 1
        assert any("cannot be expressed" in n.message for n in result.warnings())

    def test_duplicate_names_are_deduplicated(self):
        result = _emit(_lambda("My-Agent"), _lambda("my_agent"))
        names = [a["name"] for a in result.config["agents"]]
        assert len(names) == len(set(names)), "emitted duplicate agent names"

    def test_environment_variables_are_copied_and_flagged(self):
        result = _emit(_lambda("a", Environment={"Variables": {"API_KEY": "s3cret"}}))
        assert result.config["agents"][0]["environment"] == {"API_KEY": "s3cret"}
        assert any("may" in n.message and "secret" in n.message for n in result.warnings())

    def test_warpcore_tags_are_not_echoed_back_into_config(self):
        fn = _lambda("a")
        fn.tags = {"warpcore:project": "demo", "team": "platform", "Name": "a"}
        result = _emit(fn)
        assert result.config["agents"][0]["tags"] == {"team": "platform"}

    def test_unrepresentable_types_are_counted_not_dropped_silently(self):
        stream = Resource(id="s", type="AWS::Kinesis::Stream",
                          physical_id="arn:aws:kinesis:us-east-1:1:stream/s")
        result = _emit(stream)
        assert result.skipped_count == 1
        assert any("no config representation" in n.message for n in result.notes)


class TestGeneratedConfigIsValid:
    def test_emitted_config_passes_the_real_parser(self, tmp_path):
        """The whole point: the output must be a config warpcore can load."""
        result = _emit(
            _lambda("api-agent"),
            Resource(id="data", type="AWS::S3::Bucket",
                     physical_id="arn:aws:s3:::data",
                     properties={"BucketName": "data"}),
        )
        path = tmp_path / "warpcore.yaml"
        path.write_text(yaml.safe_dump(result.config, sort_keys=False))

        config = Config(str(path))
        config.load()  # raises ConfigValidationError if invalid

        assert config.project.name == "demo"
        assert [a.name for a in config.agents] == ["api-agent"]
        assert "dev" in config.environments

    def test_emitted_config_is_yaml_round_trippable(self):
        result = _emit(_lambda("a"))
        assert yaml.safe_load(yaml.safe_dump(result.config)) == result.config
