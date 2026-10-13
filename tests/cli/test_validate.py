

def test_a_project_without_a_shared_vpc_validates():
    """Every project the Visual Builder writes declares no shared VPC."""
    from types import SimpleNamespace
    from warpcore.cli.validate import _validate_vpc_config

    assert _validate_vpc_config(SimpleNamespace(shared=SimpleNamespace(vpc=None, api_gateway=None))) == []
    assert _validate_vpc_config(SimpleNamespace(shared=None)) == []
    assert _validate_vpc_config(SimpleNamespace()) == []
    enabled_without_ipam = SimpleNamespace(shared=SimpleNamespace(vpc=SimpleNamespace(enabled=True, cidr="10.0.0.0/16", ipam=None)))
    assert _validate_vpc_config(enabled_without_ipam) == []
