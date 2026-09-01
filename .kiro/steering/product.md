# Product Overview

**Warpcore** is a Python-based infrastructure deployment tool optimized for deploying Strands SDK agents and agentcore runtime to AWS. The name combines "warp" (from weaving/strands) with "agentcore" (the runtime for Strands agents).

## Core Purpose
- Deploy and manage AWS infrastructure for Strands agents
- Provide local development environment with AWS connectivity
- Optimize resource usage through shared components (IAM roles, security groups)
- Enable fast parallel deployments with state tracking

## Key Features
- Direct AWS resource management using boto3 (no CloudFormation/CDK)
- CDK-compatible state tracking
- Local development mode with live reload
- Comprehensive CLI interface
- Resource optimization and cost management
- Deployment history and rollback capabilities
- Agentic reconciliation for infrastructure drift detection

## Target Users
Platform engineers and developers working with Strands SDK agents who need reliable, fast AWS deployments with local development capabilities.