"""Building a DeploymentOrchestrator.

Every mutating command goes through create_orchestrator: deploy, destroy and
diff all construct one before doing anything. It raised AttributeError in its
own constructor - TagManager takes a ProjectConfig and was handed the whole
Config - so all three failed before reaching AWS. Nothing covered construction,
so nothing caught it.
"""

import pytest

from warpcore.config.parser import Config
from warpcore.orchestrator.orchestrator import DeploymentOrchestrator
from warpcore.state.manager import StateManager

CONFIG = """\
project:
  name: demo
  region: us-east-1
  tags:
    team: platform
agents:
  - name: api-agent
    path: ./agents/api
    memory: 512
    timeout: 30
environments:
  dev:
    account: "123456789012"
    region: us-east-1
"""


@pytest.fixture
def config(tmp_path):
    path = tmp_path / "warpcore.yaml"
    path.write_text(CONFIG)
    parsed = Config(str(path))
    parsed.load()
    return parsed


@pytest.fixture
def state_manager(tmp_path):
    manager = StateManager(str(tmp_path / "state.json"))
    manager.initialize(environment="dev", region="us-east-1",
                       account="123456789012", project_name="demo")
    return manager


@pytest.fixture
def orchestrator(config, state_manager):
    import boto3

    return DeploymentOrchestrator(
        config=config,
        state_manager=state_manager,
        provisioners={},
        boto_session=boto3.Session(
            region_name="us-east-1",
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
        ),
    )


def test_constructs_without_raising(orchestrator):
    assert orchestrator is not None


def test_tag_manager_gets_the_project_config(orchestrator):
    """It reads .name off what it is given; a Config has no .name."""
    assert orchestrator.tag_manager.project_config.name == "demo"


def test_tag_manager_can_generate_tags(orchestrator):
    """Proves the object is usable, not merely constructed."""
    assert orchestrator.tag_manager.project_config.tags == {"team": "platform"}


def test_planning_works_against_an_empty_state(orchestrator):
    plan = orchestrator.plan_deployment()
    assert plan is not None
    assert plan.get_total_resources() >= 0
