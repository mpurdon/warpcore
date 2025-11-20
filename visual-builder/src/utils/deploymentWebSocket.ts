import { NodeStatus, ExecutionLog, ExecutionStep, LogEntry, APICall } from '../store/useStore';

export interface DeploymentUpdate {
  type: 'resource_status' | 'log_entry' | 'step_complete' | 'api_call' | 'deployment_complete';
  resourceId: string;
  data: any;
}

export class DeploymentWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(
    private url: string,
    private onUpdate: (update: DeploymentUpdate) => void,
    private onError: (error: Error) => void
  ) {}

  connect() {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const update: DeploymentUpdate = JSON.parse(event.data);
          this.onUpdate(update);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.onError(new Error('WebSocket connection error'));
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.attemptReconnect();
      };
    } catch (error) {
      this.onError(error as Error);
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay * this.reconnectAttempts);
    } else {
      this.onError(new Error('Max reconnection attempts reached'));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

// Mock deployment updates for testing
export function createMockDeploymentUpdates(
  resourceIds: string[],
  onUpdate: (update: DeploymentUpdate) => void
) {
  let currentIndex = 0;

  const interval = setInterval(() => {
    if (currentIndex >= resourceIds.length) {
      clearInterval(interval);
      onUpdate({
        type: 'deployment_complete',
        resourceId: 'all',
        data: { status: 'success', duration: resourceIds.length * 3 },
      });
      return;
    }

    const resourceId = resourceIds[currentIndex];

    // Start deploying
    onUpdate({
      type: 'resource_status',
      resourceId,
      data: { status: 'deploying' },
    });

    // Simulate steps
    setTimeout(() => {
      onUpdate({
        type: 'step_complete',
        resourceId,
        data: {
          step: { id: '1', name: 'Validate configuration', status: 'success', duration: 0.5 },
        },
      });
    }, 500);

    setTimeout(() => {
      onUpdate({
        type: 'step_complete',
        resourceId,
        data: {
          step: { id: '2', name: 'Create resource', status: 'success', duration: 2.0 },
        },
      });
    }, 1500);

    setTimeout(() => {
      onUpdate({
        type: 'resource_status',
        resourceId,
        data: { status: 'success', duration: 3.0 },
      });
    }, 3000);

    currentIndex++;
  }, 3500);

  return () => clearInterval(interval);
}
