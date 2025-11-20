"""Example of using the agentic reconciliation system programmatically."""

import boto3
from strands_deploy.agentic import (
    AgenticReconciler,
    LLMClient,
    LLMProvider,
)
from strands_deploy.state.manager import StateManager
from strands_deploy.utils.errors import DeploymentError, ErrorCategory, ErrorContext


def example_drift_detection():
    """Example: Detect infrastructure drift."""
    print("=" * 60)
    print("Example 1: Drift Detection")
    print("=" * 60)
    
    # Setup
    boto_session = boto3.Session(profile_name='default', region_name='us-east-1')
    state_manager = StateManager('.strands/state/my-project-dev.json')
    
    # Create LLM client (optional - will use fallback if no API key)
    llm_client = LLMClient(provider=LLMProvider.OPENAI)
    
    # Create reconciler
    reconciler = AgenticReconciler(
        state_manager=state_manager,
        boto_session=boto_session,
        project_name='my-project',
        environment='dev',
        region='us-east-1',
        llm_client=llm_client
    )
    
    # Detect drift
    print("\nDetecting drift...")
    drift_report = reconciler.detect_drift()
    
    # Display results
    if drift_report.has_drift():
        print(f"\n⚠ Found {len(drift_report.drift_items)} drift items")
        
        for item in drift_report.drift_items:
            print(f"\n  Resource: {item.resource_id}")
            print(f"  Type: {item.drift_type.value}")
            print(f"  Severity: {item.severity.value}")
            print(f"  Differences: {', '.join(item.differences)}")
        
        # Show AI analysis if available
        if drift_report.analysis:
            print("\n" + "=" * 60)
            print("AI Analysis")
            print("=" * 60)
            print(f"\nSummary: {drift_report.analysis.summary}")
            print(f"\nImpact: {drift_report.analysis.impact}")
            
            if drift_report.analysis.recommendations:
                print("\nRecommendations:")
                for i, rec in enumerate(drift_report.analysis.recommendations, 1):
                    print(f"  {i}. {rec}")
    else:
        print("\n✓ No drift detected")


def example_failure_analysis():
    """Example: Analyze a deployment failure."""
    print("\n\n" + "=" * 60)
    print("Example 2: Failure Analysis")
    print("=" * 60)
    
    # Setup
    boto_session = boto3.Session(profile_name='default', region_name='us-east-1')
    state_manager = StateManager('.strands/state/my-project-dev.json')
    llm_client = LLMClient(provider=LLMProvider.OPENAI)
    
    reconciler = AgenticReconciler(
        state_manager=state_manager,
        boto_session=boto_session,
        project_name='my-project',
        environment='dev',
        region='us-east-1',
        llm_client=llm_client
    )
    
    # Create a sample error
    error_context = ErrorContext(
        resource_id='my-lambda-function',
        resource_type='AWS::Lambda::Function',
        operation='create'
    )
    
    error = DeploymentError(
        message='User is not authorized to perform lambda:CreateFunction',
        category=ErrorCategory.PERMISSION,
        context=error_context
    )
    
    # Analyze failure
    print("\nAnalyzing failure...")
    analysis = reconciler.analyze_failure(error)
    
    # Display results
    print(f"\nRoot Cause: {analysis.root_cause}")
    print(f"\nExplanation: {analysis.explanation}")
    
    if analysis.suggested_fixes:
        print("\nSuggested Fixes:")
        for i, fix in enumerate(analysis.suggested_fixes, 1):
            print(f"  {i}. {fix}")
    
    if analysis.prevention_tips:
        print("\nPrevention Tips:")
        for tip in analysis.prevention_tips:
            print(f"  • {tip}")
    
    print(f"\nConfidence: {analysis.confidence:.0%}")


def example_missing_resources():
    """Example: Find missing resources."""
    print("\n\n" + "=" * 60)
    print("Example 3: Missing Resources")
    print("=" * 60)
    
    # Setup
    boto_session = boto3.Session(profile_name='default', region_name='us-east-1')
    state_manager = StateManager('.strands/state/my-project-dev.json')
    llm_client = LLMClient(provider=LLMProvider.OPENAI)
    
    reconciler = AgenticReconciler(
        state_manager=state_manager,
        boto_session=boto_session,
        project_name='my-project',
        environment='dev',
        region='us-east-1',
        llm_client=llm_client
    )
    
    # Find missing resources
    print("\nScanning for missing resources...")
    missing = reconciler.find_missing_resources()
    
    # Display results
    if missing:
        print(f"\n⚠ Found {len(missing)} missing resources")
        
        for resource in missing:
            print(f"\n  Resource: {resource.resource_id}")
            print(f"  Type: {resource.resource_type}")
            print(f"  Priority: {resource.priority}/10")
            print(f"  Impact: {resource.impact}")
            if resource.reason:
                print(f"  Reason: {resource.reason}")
    else:
        print("\n✓ No missing resources")


def example_recovery_plan():
    """Example: Generate recovery plan."""
    print("\n\n" + "=" * 60)
    print("Example 4: Recovery Plan Generation")
    print("=" * 60)
    
    # Setup
    boto_session = boto3.Session(profile_name='default', region_name='us-east-1')
    state_manager = StateManager('.strands/state/my-project-dev.json')
    llm_client = LLMClient(provider=LLMProvider.OPENAI)
    
    reconciler = AgenticReconciler(
        state_manager=state_manager,
        boto_session=boto_session,
        project_name='my-project',
        environment='dev',
        region='us-east-1',
        llm_client=llm_client
    )
    
    # First detect drift
    print("\nDetecting drift...")
    drift_report = reconciler.detect_drift()
    
    if drift_report.has_drift():
        # Generate recovery plan
        print("\nGenerating recovery plan...")
        recovery_plan = reconciler.generate_recovery_plan(drift_report)
        
        # Display plan
        print(f"\nRecovery Plan:")
        print(f"Explanation: {recovery_plan.explanation}")
        print(f"\nTotal Actions: {recovery_plan.get_action_count()}")
        
        if recovery_plan.estimated_duration:
            print(f"Estimated Duration: {recovery_plan.estimated_duration}s")
        
        if recovery_plan.actions:
            print("\nActions:")
            for i, action in enumerate(recovery_plan.actions, 1):
                print(f"\n  {i}. {action.action_type.upper()}: {action.resource_id}")
                print(f"     Type: {action.resource_type}")
                print(f"     Rationale: {action.rationale}")
                if action.dependencies:
                    print(f"     Dependencies: {', '.join(action.dependencies)}")
        
        if recovery_plan.risks:
            print("\n⚠ Risks:")
            for risk in recovery_plan.risks:
                print(f"  • {risk}")
        
        if recovery_plan.rollback_plan:
            print(f"\nRollback Plan: {recovery_plan.rollback_plan}")
    else:
        print("\n✓ No drift detected - no recovery needed")


if __name__ == '__main__':
    print("\n" + "=" * 60)
    print("Agentic Reconciliation System Examples")
    print("=" * 60)
    print("\nNote: These examples require:")
    print("  1. Valid AWS credentials")
    print("  2. An existing state file")
    print("  3. LLM API key (optional - will use fallback)")
    print("\nSet environment variables:")
    print("  export OPENAI_API_KEY='your-key'")
    print("  export ANTHROPIC_API_KEY='your-key'")
    print("\n" + "=" * 60)
    
    # Run examples
    # Uncomment to run (requires valid setup)
    # example_drift_detection()
    # example_failure_analysis()
    # example_missing_resources()
    # example_recovery_plan()
    
    print("\n✓ Examples defined - uncomment to run with valid setup")
