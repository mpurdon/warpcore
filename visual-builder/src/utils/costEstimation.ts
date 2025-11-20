import { Node } from 'reactflow';

export interface CostEstimate {
  resourceId: string;
  resourceType: string;
  monthlyCost: number;
  breakdown: {
    item: string;
    cost: number;
  }[];
}

// Simplified cost estimation (real implementation would use AWS Pricing API)
const baseCosts: Record<string, number> = {
  'agent': 0, // Lambda free tier covers most development
  's3': 0.023, // per GB
  'dynamodb': 1.25, // per million requests
  'sqs': 0.40, // per million requests
  'sns': 0.50, // per million requests
  'api-gateway': 3.50, // per million requests
  'iam-role': 0, // Free
  'security-group': 0, // Free
  'vpc': 0, // Free (NAT Gateway costs extra)
  'eventbridge': 1.00, // per million events
  'lambda-url': 0, // Free (Lambda costs apply)
  'cloudwatch-alarm': 0.10, // per alarm
};

export function estimateCost(nodes: Node[]): { total: number; estimates: CostEstimate[] } {
  const estimates: CostEstimate[] = [];

  nodes.forEach(node => {
    const baseCost = baseCosts[node.type || 'agent'] || 0;
    
    let monthlyCost = baseCost;
    const breakdown: { item: string; cost: number }[] = [];

    // Agent-specific costs
    if (node.type === 'agent') {
      const memory = node.data.memory || 512;
      const timeout = node.data.timeout || 30;
      
      // Estimate based on 1M invocations per month
      const computeCost = (memory / 1024) * (timeout / 1000) * 0.0000166667 * 1000000;
      const requestCost = 0.20; // $0.20 per 1M requests
      
      monthlyCost = computeCost + requestCost;
      breakdown.push(
        { item: 'Compute', cost: computeCost },
        { item: 'Requests', cost: requestCost }
      );
    }

    // S3-specific costs
    if (node.type === 's3') {
      breakdown.push(
        { item: 'Storage (10GB)', cost: 0.23 },
        { item: 'Requests (1M)', cost: 0.40 }
      );
      monthlyCost = 0.63;
    }

    // DynamoDB-specific costs
    if (node.type === 'dynamodb') {
      breakdown.push(
        { item: 'On-demand reads (1M)', cost: 0.25 },
        { item: 'On-demand writes (1M)', cost: 1.25 },
        { item: 'Storage (10GB)', cost: 2.50 }
      );
      monthlyCost = 4.00;
    }

    // API Gateway-specific costs
    if (node.type === 'api-gateway') {
      breakdown.push(
        { item: 'HTTP API requests (1M)', cost: 1.00 },
        { item: 'Data transfer', cost: 0.09 }
      );
      monthlyCost = 1.09;
    }

    estimates.push({
      resourceId: node.id,
      resourceType: node.type || 'unknown',
      monthlyCost,
      breakdown,
    });
  });

  const total = estimates.reduce((sum, est) => sum + est.monthlyCost, 0);

  return { total, estimates };
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
