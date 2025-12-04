"""Deployment notifications system."""

import click
from rich.console import Console
import json
import os
import requests
from typing import Dict, Optional
from datetime import datetime

from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()

NOTIFICATIONS_CONFIG_FILE = '.strands/notifications.json'


@click.group()
def notifications():
    """Manage deployment notifications."""
    pass


@notifications.command()
@click.option('--json-output', is_flag=True, help='Output in JSON format')
def show(json_output: bool):
    """Show notification configuration."""
    config = _load_config()
    
    if json_output:
        console.print_json(data=config)
    else:
        _display_config(config)


@notifications.command()
@click.option('--slack-webhook', help='Slack webhook URL')
@click.option('--discord-webhook', help='Discord webhook URL')
@click.option('--email', help='Email address for notifications')
@click.option('--pagerduty-key', help='PagerDuty integration key')
def configure(slack_webhook: str, discord_webhook: str, email: str, pagerduty_key: str):
    """Configure notification channels."""
    config = _load_config()
    
    if slack_webhook:
        config['channels']['slack']['webhook_url'] = slack_webhook
        config['channels']['slack']['enabled'] = True
        console.print("[green]✓ Slack webhook configured[/green]")
    
    if discord_webhook:
        config['channels']['discord']['webhook_url'] = discord_webhook
        config['channels']['discord']['enabled'] = True
        console.print("[green]✓ Discord webhook configured[/green]")
    
    if email:
        config['channels']['email']['address'] = email
        config['channels']['email']['enabled'] = True
        console.print("[green]✓ Email configured[/green]")
    
    if pagerduty_key:
        config['channels']['pagerduty']['integration_key'] = pagerduty_key
        config['channels']['pagerduty']['enabled'] = True
        console.print("[green]✓ PagerDuty configured[/green]")
    
    _save_config(config)


@notifications.command()
@click.argument('channel', type=click.Choice(['slack', 'discord', 'email', 'pagerduty']))
@click.argument('enabled', type=click.Choice(['on', 'off']))
def toggle(channel: str, enabled: str):
    """Enable or disable a notification channel."""
    config = _load_config()
    
    is_enabled = enabled == 'on'
    config['channels'][channel]['enabled'] = is_enabled
    
    _save_config(config)
    
    status = "enabled" if is_enabled else "disabled"
    console.print(f"[green]✓ {channel.capitalize()} notifications {status}[/green]")


@notifications.command()
@click.option('--event', type=click.Choice(['deployment_start', 'deployment_success', 'deployment_failure', 'cost_alert']), 
              required=True, help='Event type')
@click.argument('enabled', type=click.Choice(['on', 'off']))
def event(event: str, enabled: str):
    """Enable or disable notifications for specific events."""
    config = _load_config()
    
    is_enabled = enabled == 'on'
    config['events'][event] = is_enabled
    
    _save_config(config)
    
    status = "enabled" if is_enabled else "disabled"
    console.print(f"[green]✓ Notifications for '{event}' {status}[/green]")


@notifications.command()
@click.option('--message', required=True, help='Test message')
def test(message: str):
    """Test notification configuration."""
    config = _load_config()
    
    console.print("[bold]Testing notification channels...[/bold]")
    console.print()
    
    success_count = 0
    
    for channel_name, channel_config in config['channels'].items():
        if not channel_config.get('enabled', False):
            console.print(f"[dim]Skipping {channel_name} (disabled)[/dim]")
            continue
        
        console.print(f"Testing {channel_name}...", end=" ")
        
        try:
            _send_notification(
                channel_name=channel_name,
                channel_config=channel_config,
                event='test',
                data={'message': message}
            )
            console.print("[green]✓[/green]")
            success_count += 1
        except Exception as e:
            console.print(f"[red]✗ {e}[/red]")
    
    console.print()
    console.print(f"[bold]Sent test to {success_count} channel(s)[/bold]")


def send_deployment_notification(event: str, data: Dict):
    """Send deployment notification to configured channels."""
    config = _load_config()
    
    # Check if event notifications are enabled
    if not config['events'].get(event, False):
        return
    
    # Send to each enabled channel
    for channel_name, channel_config in config['channels'].items():
        if not channel_config.get('enabled', False):
            continue
        
        try:
            _send_notification(channel_name, channel_config, event, data)
        except Exception as e:
            logger.error(f"Failed to send notification to {channel_name}: {e}")


def _send_notification(channel_name: str, channel_config: Dict, event: str, data: Dict):
    """Send notification to specific channel."""
    if channel_name == 'slack':
        _send_slack(channel_config['webhook_url'], event, data)
    elif channel_name == 'discord':
        _send_discord(channel_config['webhook_url'], event, data)
    elif channel_name == 'email':
        _send_email(channel_config['address'], event, data)
    elif channel_name == 'pagerduty':
        _send_pagerduty(channel_config['integration_key'], event, data)


def _send_slack(webhook_url: str, event: str, data: Dict):
    """Send Slack notification."""
    color = {
        'deployment_start': '#2196F3',
        'deployment_success': '#4CAF50',
        'deployment_failure': '#F44336',
        'cost_alert': '#FF9800',
        'test': '#9E9E9E'
    }.get(event, '#9E9E9E')
    
    emoji = {
        'deployment_start': ':rocket:',
        'deployment_success': ':white_check_mark:',
        'deployment_failure': ':x:',
        'cost_alert': ':warning:',
        'test': ':test_tube:'
    }.get(event, ':bell:')
    
    title = event.replace('_', ' ').title()
    
    payload = {
        'attachments': [{
            'color': color,
            'title': f"{emoji} {title}",
            'fields': [
                {'title': key.replace('_', ' ').title(), 'value': str(value), 'short': True}
                for key, value in data.items()
            ],
            'footer': 'Strands Deploy',
            'ts': int(datetime.now().timestamp())
        }]
    }
    
    response = requests.post(webhook_url, json=payload, timeout=10)
    response.raise_for_status()


def _send_discord(webhook_url: str, event: str, data: Dict):
    """Send Discord notification."""
    color = {
        'deployment_start': 0x2196F3,
        'deployment_success': 0x4CAF50,
        'deployment_failure': 0xF44336,
        'cost_alert': 0xFF9800,
        'test': 0x9E9E9E
    }.get(event, 0x9E9E9E)
    
    title = event.replace('_', ' ').title()
    
    fields = [
        {'name': key.replace('_', ' ').title(), 'value': str(value), 'inline': True}
        for key, value in data.items()
    ]
    
    payload = {
        'embeds': [{
            'title': title,
            'color': color,
            'fields': fields,
            'footer': {'text': 'Strands Deploy'},
            'timestamp': datetime.now().isoformat()
        }]
    }
    
    response = requests.post(webhook_url, json=payload, timeout=10)
    response.raise_for_status()


def _send_email(email_address: str, event: str, data: Dict):
    """Send email notification."""
    # This would integrate with AWS SES or another email service
    # For now, just log
    logger.info(f"Would send email to {email_address}: {event} - {data}")
    console.print(f"[yellow]Email notifications require AWS SES configuration[/yellow]")


def _send_pagerduty(integration_key: str, event: str, data: Dict):
    """Send PagerDuty notification."""
    # Only send to PagerDuty for failures and critical alerts
    if event not in ['deployment_failure', 'cost_alert']:
        return
    
    severity = 'error' if event == 'deployment_failure' else 'warning'
    
    payload = {
        'routing_key': integration_key,
        'event_action': 'trigger',
        'payload': {
            'summary': event.replace('_', ' ').title(),
            'severity': severity,
            'source': 'strands-deploy',
            'custom_details': data
        }
    }
    
    response = requests.post(
        'https://events.pagerduty.com/v2/enqueue',
        json=payload,
        timeout=10
    )
    response.raise_for_status()


def _load_config() -> dict:
    """Load notifications configuration."""
    if os.path.exists(NOTIFICATIONS_CONFIG_FILE):
        try:
            with open(NOTIFICATIONS_CONFIG_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load notifications config: {e}")
    
    return {
        'channels': {
            'slack': {'enabled': False, 'webhook_url': ''},
            'discord': {'enabled': False, 'webhook_url': ''},
            'email': {'enabled': False, 'address': ''},
            'pagerduty': {'enabled': False, 'integration_key': ''}
        },
        'events': {
            'deployment_start': True,
            'deployment_success': True,
            'deployment_failure': True,
            'cost_alert': True
        }
    }


def _save_config(config: dict):
    """Save notifications configuration."""
    os.makedirs(os.path.dirname(NOTIFICATIONS_CONFIG_FILE), exist_ok=True)
    
    with open(NOTIFICATIONS_CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)


def _display_config(config: dict):
    """Display notifications configuration."""
    from rich.table import Table
    from rich.panel import Panel
    
    console.print(Panel("Notification Configuration", style="bold blue"))
    console.print()
    
    # Channels
    console.print("[bold cyan]Channels[/bold cyan]")
    table = Table(show_header=True, header_style="bold")
    table.add_column("Channel", style="white")
    table.add_column("Status", style="green")
    table.add_column("Configuration")
    
    for channel_name, channel_config in config['channels'].items():
        status = "[green]Enabled[/green]" if channel_config.get('enabled') else "[dim]Disabled[/dim]"
        
        # Show configuration (masked)
        config_str = ""
        if channel_name == 'slack' and channel_config.get('webhook_url'):
            config_str = "Webhook configured"
        elif channel_name == 'discord' and channel_config.get('webhook_url'):
            config_str = "Webhook configured"
        elif channel_name == 'email' and channel_config.get('address'):
            config_str = channel_config['address']
        elif channel_name == 'pagerduty' and channel_config.get('integration_key'):
            config_str = "Integration key configured"
        else:
            config_str = "[dim]Not configured[/dim]"
        
        table.add_row(channel_name.capitalize(), status, config_str)
    
    console.print(table)
    console.print()
    
    # Events
    console.print("[bold cyan]Events[/bold cyan]")
    table = Table(show_header=True, header_style="bold")
    table.add_column("Event", style="white")
    table.add_column("Notifications", style="green")
    
    for event_name, enabled in config['events'].items():
        status = "[green]Enabled[/green]" if enabled else "[dim]Disabled[/dim]"
        table.add_row(event_name.replace('_', ' ').title(), status)
    
    console.print(table)
    console.print()
    console.print(f"[dim]Config file: {NOTIFICATIONS_CONFIG_FILE}[/dim]")
