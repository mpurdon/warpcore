"""Resource Explorer as a discovery source.

moto does not implement resource-explorer-2, so the client is stubbed. What is
under test is the mapping from Resource Explorer's record shape to warpcore's,
and the availability check that decides whether to use it at all.
"""

from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from warpcore.discovery.resource_explorer import (
    ResourceExplorerSource,
    map_type,
)


def _hit(arn, resource_type, region="us-east-1", tags=None):
    return {
        "Arn": arn,
        "OwningAccountId": "775665388639",
        "Region": region,
        "ResourceType": resource_type,
        "Service": resource_type.split(":")[0],
        "LastReportedAt": "2026-08-28 08:12:10+00:00",
        "Properties": [{"Name": "tags", "Data": [
            {"Key": k, "Value": v} for k, v in (tags or {}).items()
        ]}] if tags else [],
    }


def _source_with(hits, views=None):
    client = Mock()
    client.list_views.return_value = {"Views": views if views is not None else ["arn:view"]}
    paginator = Mock()
    paginator.paginate.return_value = [{"Resources": hits}]
    client.get_paginator.return_value = paginator
    session = Mock()
    session.client.return_value = client
    return ResourceExplorerSource(session), client


class TestTypeMapping:
    @pytest.mark.parametrize("explorer,warpcore_type", [
        ("ec2:instance", "AWS::EC2::Instance"),
        ("lambda:function", "AWS::Lambda::Function"),
        ("s3:bucket", "AWS::S3::Bucket"),
        ("states:stateMachine", "AWS::StepFunctions::StateMachine"),
        ("config:config-rule", "AWS::Config::ConfigRule"),
    ])
    def test_known_types_use_warpcore_names(self, explorer, warpcore_type):
        """Both sources must name a type identically or the merge duplicates it."""
        assert map_type(explorer) == warpcore_type

    def test_unknown_type_gets_a_readable_generated_name(self):
        assert map_type("memorydb:parametergroup") == "AWS::Memorydb::Parametergroup"
        assert map_type("s3:storage-lens") == "AWS::S3::StorageLens"

    def test_enumerator_and_explorer_agree_on_ec2_types(self):
        """The enumerator synthesises ARNs; the explorer returns real ones. The
        types must match or a resource seen by both is reported twice."""
        from warpcore.utils.arn import resource_type_from_arn

        arn = "arn:aws:ec2:us-east-1:1:instance/i-abc"
        assert map_type("ec2:instance") == resource_type_from_arn(arn)


class TestAvailability:
    def test_available_when_a_view_exists(self):
        source, _ = _source_with([])
        assert source.availability("us-east-1").available

    def test_unavailable_with_no_view(self):
        source, _ = _source_with([], views=[])
        result = source.availability("us-east-1")
        assert not result.available
        assert "no Resource Explorer view" in result.reason

    def test_unavailable_when_the_api_is_denied(self):
        source, client = _source_with([])
        client.list_views.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "ListViews"
        )
        result = source.availability("us-east-1")
        assert not result.available
        assert "AccessDenied" in result.reason


class TestSearch:
    def test_converts_hits_to_resources(self):
        source, _ = _source_with([
            _hit("arn:aws:ec2:us-east-1:1:instance/i-abc", "ec2:instance",
                 tags={"Name": "web-1", "env": "dev"}),
        ])
        [resource] = source.search("us-east-1")
        assert resource.id == "web-1"
        assert resource.type == "AWS::EC2::Instance"
        assert resource.physical_id == "arn:aws:ec2:us-east-1:1:instance/i-abc"
        assert resource.tags == {"Name": "web-1", "env": "dev"}

    def test_untagged_hit_uses_the_arn_tail_as_id(self):
        source, _ = _source_with([_hit("arn:aws:s3:::my-bucket", "s3:bucket")])
        [resource] = source.search("us-east-1")
        assert resource.id == "my-bucket"

    def test_records_provenance_in_metadata(self):
        source, _ = _source_with([_hit("arn:aws:s3:::b", "s3:bucket", region="global")])
        [resource] = source.search("us-east-1")
        assert resource.metadata["source"] == "resource-explorer"
        assert resource.metadata["region"] == "global"
        assert resource.metadata["explorer_type"] == "s3:bucket"

    def test_max_resources_caps_the_result(self):
        source, _ = _source_with([
            _hit(f"arn:aws:s3:::b{i}", "s3:bucket") for i in range(5)
        ])
        assert len(source.search("us-east-1", max_resources=2)) == 2

    def test_search_failure_propagates(self):
        source, client = _source_with([])
        client.get_paginator.return_value.paginate.side_effect = ClientError(
            {"Error": {"Code": "UnauthorizedException", "Message": "no"}}, "Search"
        )
        with pytest.raises(ClientError):
            source.search("us-east-1")
