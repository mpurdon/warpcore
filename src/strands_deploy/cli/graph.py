"""Graph command for visualizing resource dependencies."""

import click
from rich.console import Console
from rich.tree import Tree
from rich.panel import Panel
from typing import Dict, List, Set
import json
import subprocess
import tempfile
import os

from ..config.parser import ConfigParser
from ..state.manager import StateManager
from ..orchestrator.dependency_graph import DependencyGraph
from ..utils.logging import get_logger

logger = get_logger(__name__)
console = Console()


@click.command()
@click.option('--env', required=True, help='Environment name')
@click.option('--agent', help='Specific agent to show graph for')
@click.option('--format', type=click.Choice(['tree', 'dot', 'ascii']), default='tree', help='Output format')
@click.option('--output', help='Output file for dot format (opens in browser if not specified)')
def graph(env: str, agent: str, format: str, output: str):
    """Visualize resource dependency graph."""
    try:
        # Load configuration
        config_parser = ConfigParser('strands.yaml')
        config = config_parser.parse()
        
        # Validate environment
        if env not in config.environments:
            console.print(f"[red]Error: Environment '{env}' not found in configuration[/red]")
            return
        
        # Load current state
        state_manager = StateManager(f'.strands/state/{env}.json')
        current_state = state_manager.load()
        
        # Build dependency graph
        dep_graph = DependencyGraph()
        
        # Add resources from state
        for stack_name, stack in current_state.stacks.items():
            if agent and agent not in stack_name:
                continue
            
            for resource_id, resource in stack.resources.items():
                dep_graph.add_resource(resource)
                
                for dep in resource.dependencies:
                    dep_graph.add_dependency(resource_id, dep)
        
        # Output based on format
        if format == 'tree':
            _output_tree(dep_graph, env, agent)
        elif format == 'ascii':
            _output_ascii(dep_graph, env, agent)
        elif format == 'dot':
            _output_dot(dep_graph, env, agent, output)
            
    except FileNotFoundError as e:
        console.print(f"[red]Error: File not found: {e}[/red]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        logger.exception("Failed to generate graph")


def _output_tree(dep_graph: DependencyGraph, env: str, agent: str):
    """Output dependency graph as a tree."""
    title = f"Resource Dependency Graph - Environment: {env}"
    if agent:
        title += f" (Agent: {agent})"
    
    console.print(Panel(title, style="bold blue"))
    console.print()
    
    # Get root resources (no dependencies)
    roots = dep_graph.get_roots()
    
    if not roots:
        console.print("[dim]No resources found[/dim]")
        return
    
    # Build tree for each root
    for root in roots:
        tree = Tree(f"[bold cyan]{root}[/bold cyan]")
        _build_tree_recursive(tree, root, dep_graph, set())
        console.print(tree)
        console.print()


def _build_tree_recursive(tree: Tree, resource_id: str, dep_graph: DependencyGraph, visited: Set[str]):
    """Recursively build tree structure."""
    if resource_id in visited:
        tree.add(f"[dim]{resource_id} (circular)[/dim]")
        return
    
    visited.add(resource_id)
    dependents = dep_graph.get_dependents(resource_id)
    
    for dependent in dependents:
        branch = tree.add(f"[cyan]{dependent}[/cyan]")
        _build_tree_recursive(branch, dependent, dep_graph, visited.copy())


def _output_ascii(dep_graph: DependencyGraph, env: str, agent: str):
    """Output dependency graph as ASCII art."""
    title = f"Resource Dependency Graph - Environment: {env}"
    if agent:
        title += f" (Agent: {agent})"
    
    console.print(Panel(title, style="bold blue"))
    console.print()
    
    # Get topological order
    try:
        ordered = dep_graph.topological_sort()
    except Exception as e:
        console.print(f"[red]Error: Cannot create graph - {e}[/red]")
        return
    
    # Group by level
    levels = _compute_levels(dep_graph, ordered)
    max_level = max(levels.values()) if levels else 0
    
    # Print level by level
    for level in range(max_level + 1):
        resources = [r for r, l in levels.items() if l == level]
        
        if resources:
            console.print(f"[bold]Level {level}:[/bold]")
            for resource in resources:
                deps = dep_graph.get_dependencies(resource)
                if deps:
                    console.print(f"  ├─ [cyan]{resource}[/cyan] [dim]← depends on: {', '.join(deps)}[/dim]")
                else:
                    console.print(f"  ├─ [cyan]{resource}[/cyan]")
            console.print()


def _compute_levels(dep_graph: DependencyGraph, ordered: List[str]) -> Dict[str, int]:
    """Compute level for each resource based on dependencies."""
    levels = {}
    
    for resource in ordered:
        deps = dep_graph.get_dependencies(resource)
        if not deps:
            levels[resource] = 0
        else:
            max_dep_level = max(levels.get(dep, 0) for dep in deps)
            levels[resource] = max_dep_level + 1
    
    return levels


def _output_dot(dep_graph: DependencyGraph, env: str, agent: str, output: str):
    """Output dependency graph in DOT format and optionally render."""
    # Generate DOT content
    dot_content = _generate_dot(dep_graph, env, agent)
    
    if output:
        # Save to file
        with open(output, 'w') as f:
            f.write(dot_content)
        console.print(f"[green]Graph saved to {output}[/green]")
        
        # Try to render if graphviz is available
        if output.endswith('.dot'):
            png_output = output.replace('.dot', '.png')
            try:
                subprocess.run(['dot', '-Tpng', output, '-o', png_output], check=True)
                console.print(f"[green]Rendered graph saved to {png_output}[/green]")
            except (subprocess.CalledProcessError, FileNotFoundError):
                console.print("[yellow]Install graphviz to render the graph: brew install graphviz[/yellow]")
    else:
        # Create temporary file and open in browser
        with tempfile.NamedTemporaryFile(mode='w', suffix='.dot', delete=False) as f:
            f.write(dot_content)
            dot_file = f.name
        
        try:
            # Try to render to SVG
            svg_file = dot_file.replace('.dot', '.svg')
            subprocess.run(['dot', '-Tsvg', dot_file, '-o', svg_file], check=True)
            
            # Open in browser
            subprocess.run(['open', svg_file])
            console.print("[green]Graph opened in browser[/green]")
        except (subprocess.CalledProcessError, FileNotFoundError):
            # Fallback: just print the DOT content
            console.print("[yellow]Install graphviz to visualize: brew install graphviz[/yellow]")
            console.print("\n[bold]DOT format:[/bold]")
            console.print(dot_content)
        finally:
            # Cleanup
            try:
                os.unlink(dot_file)
            except:
                pass


def _generate_dot(dep_graph: DependencyGraph, env: str, agent: str) -> str:
    """Generate DOT format graph."""
    lines = [
        'digraph ResourceDependencies {',
        '  rankdir=TB;',
        '  node [shape=box, style=rounded, fontname="Arial"];',
        '  edge [fontname="Arial"];',
        ''
    ]
    
    # Add title
    title = f"Resource Dependencies\\n{env}"
    if agent:
        title += f" - {agent}"
    lines.append(f'  labelloc="t";')
    lines.append(f'  label="{title}";')
    lines.append('')
    
    # Get all resources
    resources = dep_graph.get_all_resources()
    
    # Add nodes with colors based on resource type
    for resource_id in resources:
        resource = dep_graph.get_resource(resource_id)
        color = _get_resource_color(resource.type)
        label = resource_id.replace('-', '\\n')
        lines.append(f'  "{resource_id}" [label="{label}", fillcolor="{color}", style="filled,rounded"];')
    
    lines.append('')
    
    # Add edges
    for resource_id in resources:
        deps = dep_graph.get_dependencies(resource_id)
        for dep in deps:
            lines.append(f'  "{dep}" -> "{resource_id}";')
    
    lines.append('}')
    
    return '\n'.join(lines)


def _get_resource_color(resource_type: str) -> str:
    """Get color for resource type."""
    color_map = {
        'AWS::Lambda::Function': '#FF9900',
        'AWS::IAM::Role': '#DD344C',
        'AWS::ApiGateway::RestApi': '#5294CF',
        'AWS::ApiGatewayV2::Api': '#5294CF',
        'AWS::EC2::VPC': '#248814',
        'AWS::EC2::SecurityGroup': '#248814',
        'AWS::S3::Bucket': '#569A31',
        'AWS::DynamoDB::Table': '#2E73B8',
        'AWS::SQS::Queue': '#FF4F8B',
        'AWS::SNS::Topic': '#D9A741',
    }
    return color_map.get(resource_type, '#CCCCCC')
