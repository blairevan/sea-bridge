/** Web-only configuration, parsed separately to preserve bridge availability. */
export interface WebConfig {
  enabled: boolean;
  port: number;
  controlSocketPath: string;
  remoteOrigin: string | null;
  operationPepperPath: string;
}

/** Service boundary shared by HTTP/control lifecycle composition. */
export interface WebService {
  start(): Promise<void>;
  stop(): Promise<void>;
}
