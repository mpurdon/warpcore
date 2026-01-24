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

// Allowed execution steps for the slider
export const EXECUTION_STEPS = [1, 100, 500, 5000, 50000, 100000, 250000, 500000, 750000, 1000000] as const;
export type ExecutionStep = typeof EXECUTION_STEPS[number];

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
  'api-route': 0, // Free (API Gateway costs apply)
  'cloudwatch-alarm': 0.10, // per alarm
};

export function estimateCost(nodes: Node[], executionsPerMonth: number = 100000): { total: number; estimates: CostEstimate[] } {
  const estimates: CostEstimate[] = [];
  const executionMultiplier = executionsPerMonth / 1000000; // Convert to millions

  nodes.forEach(node => {
    const baseCost = baseCosts[node.type || 'agent'] || 0;
    
    let monthlyCost = baseCost;
    const breakdown: { item: string; cost: number }[] = [];

    // Agent-specific costs (Lambda)
    if (node.type === 'agent') {
      const memory = node.data.memory || 512;
      const timeout = node.data.timeout || 30;
      
      // Compute cost: $0.0000166667 per GB-second
      const computeCost = (memory / 1024) * (timeout / 1000) * 0.0000166667 * executionsPerMonth;
      // Request cost: $0.20 per 1M requests
      const requestCost = 0.20 * executionMultiplier;
      
      monthlyCost = computeCost + requestCost;
      breakdown.push(
        { item: `Compute (${formatExecutions(executionsPerMonth)} exec)`, cost: computeCost },
        { item: 'Requests', cost: requestCost }
      );
    }

    // S3-specific costs
    if (node.type === 's3') {
      breakdown.push(
        { item: 'Storage (10GB)', cost: 0.23 },
        { item: `Requests (${formatExecutions(executionsPerMonth)})`, cost: 0.40 * executionMultiplier }
      );
      monthlyCost = 0.23 + (0.40 * executionMultiplier);
    }

    // DynamoDB-specific costs
    if (node.type === 'dynamodb') {
      const readCost = 0.25 * executionMultiplier;
      const writeCost = 1.25 * executionMultiplier;
      breakdown.push(
        { item: `On-demand reads (${formatExecutions(executionsPerMonth)})`, cost: readCost },
        { item: `On-demand writes (${formatExecutions(executionsPerMonth)})`, cost: writeCost },
        { item: 'Storage (10GB)', cost: 2.50 }
      );
      monthlyCost = readCost + writeCost + 2.50;
    }

    // API Gateway-specific costs
    if (node.type === 'api-gateway') {
      const requestCost = 1.00 * executionMultiplier;
      breakdown.push(
        { item: `HTTP API requests (${formatExecutions(executionsPerMonth)})`, cost: requestCost },
        { item: 'Data transfer', cost: 0.09 * executionMultiplier }
      );
      monthlyCost = requestCost + (0.09 * executionMultiplier);
    }

    // SQS-specific costs
    if (node.type === 'sqs') {
      const sqsCost = 0.40 * executionMultiplier;
      breakdown.push(
        { item: `Messages (${formatExecutions(executionsPerMonth)})`, cost: sqsCost }
      );
      monthlyCost = sqsCost;
    }

    // SNS-specific costs
    if (node.type === 'sns') {
      const snsCost = 0.50 * executionMultiplier;
      breakdown.push(
        { item: `Notifications (${formatExecutions(executionsPerMonth)})`, cost: snsCost }
      );
      monthlyCost = snsCost;
    }

    // EventBridge-specific costs
    if (node.type === 'eventbridge') {
      const eventCost = 1.00 * executionMultiplier;
      breakdown.push(
        { item: `Events (${formatExecutions(executionsPerMonth)})`, cost: eventCost }
      );
      monthlyCost = eventCost;
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

export function formatExecutions(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  } else if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}K`;
  }
  return count.toString();
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
