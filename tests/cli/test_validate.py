

def test_the_vpc_check_reads_optional_fields_rather_than_probing_them():
    """Pydantic fields always exist, so every check is a None check.

    The crash this guards against: a project with no shared VPC (every one
    the Visual Builder writes), and a VPC enabled with neither a CIDR nor
    IPAM, both used to raise out of the validate command.
    """
    from types import SimpleNamespace
    from warpcore.cli.validate import _validate_vpc_config

    def vpc(**kw):
        return SimpleNamespace(shared=SimpleNamespace(vpc=SimpleNamespace(**{"enabled": True, "cidr": None, "ipam": None, **kw})))

    assert _validate_vpc_config(SimpleNamespace(shared=SimpleNamespace(vpc=None))) == []
    assert _validate_vpc_config(SimpleNamespace(shared=None)) == []
    assert _validate_vpc_config(SimpleNamespace()) == []
    assert _validate_vpc_config(vpc(enabled=False)) == []
    assert _validate_vpc_config(vpc(cidr="10.0.0.0/16")) == []
    assert _validate_vpc_config(vpc(ipam=SimpleNamespace(enabled=True, pool_id="ipam-1", netmask_length=24))) == []

    [bad] = _validate_vpc_config(vpc(cidr="10.0.0.0"))
    assert bad.field == "shared.vpc.cidr" and "Invalid CIDR" in bad.message
    [missing] = _validate_vpc_config(vpc())
    assert "either a CIDR or an IPAM pool" in missing.message
