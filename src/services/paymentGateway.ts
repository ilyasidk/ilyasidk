/**
 * Payment Gateway Service
 * 
 * Handles external payment API calls with:
 * - Configurable timeouts
 * - Exponential backoff retry logic
 * - Circuit breaker pattern
 * - Request queuing for failed payments
 * - Comprehensive error handling
 */

import axios, { AxiosInstance, AxiosError } from 'axios';

interface PaymentRequest {
  amount: number;
  currency: string;
  customerId: string;
  orderId: string;
  metadata?: Record<string, any>;
}

interface PaymentResponse {
  transactionId: string;
  status: 'success' | 'pending' | 'failed';
  message?: string;
}

interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
}

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.config.resetTimeout) {
        console.log('[CircuitBreaker] Transitioning to HALF_OPEN state');
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new Error('Circuit breaker is OPEN - service unavailable');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      console.log('[CircuitBreaker] Service recovered - transitioning to CLOSED state');
      this.state = CircuitState.CLOSED;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      console.error(`[CircuitBreaker] Failure threshold reached (${this.failureCount}/${this.config.failureThreshold}) - OPENING circuit`);
      this.state = CircuitState.OPEN;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

export class PaymentGatewayService {
  private client: AxiosInstance;
  private retryConfig: RetryConfig;
  private circuitBreaker: CircuitBreaker;
  private failedPaymentsQueue: PaymentRequest[] = [];

  constructor() {
    // FIXED: Increased timeout from 5000ms to 30000ms (30 seconds)
    // Payment operations typically need more time for processing
    this.client = axios.create({
      baseURL: process.env.PAYMENT_GATEWAY_URL || 'https://api.payment-gateway.com',
      timeout: 30000, // 30 seconds instead of 5 seconds
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PAYMENT_GATEWAY_API_KEY}`,
      },
    });

    // FIXED: Implemented exponential backoff retry strategy
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000, // Start with 1 second
      maxDelay: 10000, // Cap at 10 seconds
      backoffMultiplier: 2, // Double the delay each time
    };

    // FIXED: Added circuit breaker to prevent cascading failures
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5, // Open circuit after 5 consecutive failures
      resetTimeout: 60000, // Try again after 1 minute
    });
  }

  /**
   * Process a payment with retry logic and circuit breaker
   */
  async processPayment(request: PaymentRequest): Promise<PaymentResponse> {
    try {
      return await this.circuitBreaker.execute(async () => {
        return await this.executeWithRetry(request);
      });
    } catch (error) {
      console.error('[PaymentGateway] Payment failed after all retries:', error);
      
      // Queue failed payment for later processing
      this.queueFailedPayment(request);
      
      throw this.handleError(error);
    }
  }

  /**
   * Execute payment request with exponential backoff retry
   */
  private async executeWithRetry(request: PaymentRequest): Promise<PaymentResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        console.log(`[PaymentGateway] Attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1} for order ${request.orderId}`);
        
        const response = await this.client.post<PaymentResponse>('/payments', request);
        
        console.log(`[PaymentGateway] Payment successful for order ${request.orderId}:`, response.data);
        return response.data;
        
      } catch (error) {
        lastError = error as Error;
        const axiosError = error as AxiosError;
        
        // Don't retry on client errors (4xx) except 408 (timeout) and 429 (rate limit)
        if (axiosError.response?.status) {
          const status = axiosError.response.status;
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            console.error(`[PaymentGateway] Client error ${status} - not retrying`);
            throw error;
          }
        }

        // If this was the last attempt, throw the error
        if (attempt === this.retryConfig.maxRetries) {
          console.error(`[PaymentGateway] All retry attempts exhausted for order ${request.orderId}`);
          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateBackoffDelay(attempt);
        console.warn(`[PaymentGateway] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, {
          error: axiosError.message,
          status: axiosError.response?.status,
        });
        
        await this.sleep(delay);
      }
    }

    throw lastError || new Error('Payment processing failed');
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = Math.min(
      this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
      this.retryConfig.maxDelay
    );

    // Add jitter (random variation) to prevent thundering herd
    const jitter = Math.random() * 0.3 * exponentialDelay;
    return Math.floor(exponentialDelay + jitter);
  }

  /**
   * Queue failed payment for later retry
   */
  private queueFailedPayment(request: PaymentRequest): void {
    console.log(`[PaymentGateway] Queueing failed payment for order ${request.orderId}`);
    this.failedPaymentsQueue.push(request);
    
    // In production, this should be persisted to a database or message queue
    // For now, we'll just log it
    console.warn('[PaymentGateway] Failed payments queue size:', this.failedPaymentsQueue.length);
  }

  /**
   * Retry all queued failed payments
   */
  async retryFailedPayments(): Promise<void> {
    if (this.failedPaymentsQueue.length === 0) {
      console.log('[PaymentGateway] No failed payments to retry');
      return;
    }

    console.log(`[PaymentGateway] Retrying ${this.failedPaymentsQueue.length} failed payments...`);
    const queue = [...this.failedPaymentsQueue];
    this.failedPaymentsQueue = [];

    for (const payment of queue) {
      try {
        await this.processPayment(payment);
        console.log(`[PaymentGateway] Successfully retried payment for order ${payment.orderId}`);
      } catch (error) {
        console.error(`[PaymentGateway] Retry failed for order ${payment.orderId}:`, error);
        // Payment will be re-queued by processPayment
      }
    }
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(): { state: CircuitState; queuedPayments: number } {
    return {
      state: this.circuitBreaker.getState(),
      queuedPayments: this.failedPaymentsQueue.length,
    };
  }

  /**
   * Handle and normalize errors
   */
  private handleError(error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      
      if (axiosError.code === 'ECONNABORTED') {
        return new Error(`Payment gateway timeout after 30 seconds`);
      }
      
      if (axiosError.response) {
        return new Error(
          `Payment gateway error: ${axiosError.response.status} - ${axiosError.response.statusText}`
        );
      }
      
      if (axiosError.request) {
        return new Error('No response received from payment gateway');
      }
    }
    
    return error instanceof Error ? error : new Error('Unknown payment error');
  }

  /**
   * Sleep utility for delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const paymentGateway = new PaymentGatewayService();
