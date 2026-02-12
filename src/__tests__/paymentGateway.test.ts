/**
 * Payment Gateway Service Tests
 */

import { PaymentGatewayService } from '../services/paymentGateway';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PaymentGatewayService', () => {
  let service: PaymentGatewayService;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock axios.create
    mockCreate = jest.fn().mockReturnValue({
      post: jest.fn(),
    });
    mockedAxios.create = mockCreate;
    
    service = new PaymentGatewayService();
  });

  describe('Timeout Configuration', () => {
    it('should create axios instance with 30 second timeout', () => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 30000, // 30 seconds
        })
      );
    });
  });

  describe('Payment Processing', () => {
    it('should successfully process a payment', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: {
          transactionId: 'txn_123',
          status: 'success',
        },
      });
      
      mockCreate.mockReturnValue({
        post: mockPost,
      });
      
      service = new PaymentGatewayService();
      
      const result = await service.processPayment({
        amount: 100,
        currency: 'USD',
        customerId: 'cust_123',
        orderId: 'order_123',
      });

      expect(result.transactionId).toBe('txn_123');
      expect(result.status).toBe('success');
    });

    it('should retry on timeout errors with exponential backoff', async () => {
      const mockPost = jest.fn()
        .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' })
        .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' })
        .mockResolvedValueOnce({
          data: {
            transactionId: 'txn_456',
            status: 'success',
          },
        });
      
      mockCreate.mockReturnValue({
        post: mockPost,
      });
      
      service = new PaymentGatewayService();
      
      const result = await service.processPayment({
        amount: 200,
        currency: 'USD',
        customerId: 'cust_456',
        orderId: 'order_456',
      });

      expect(mockPost).toHaveBeenCalledTimes(3);
      expect(result.transactionId).toBe('txn_456');
    });

    it('should not retry on 4xx client errors', async () => {
      const mockPost = jest.fn().mockRejectedValue({
        response: {
          status: 400,
          statusText: 'Bad Request',
        },
      });
      
      mockCreate.mockReturnValue({
        post: mockPost,
      });
      
      service = new PaymentGatewayService();
      
      await expect(
        service.processPayment({
          amount: 100,
          currency: 'USD',
          customerId: 'cust_789',
          orderId: 'order_789',
        })
      ).rejects.toThrow();

      // Should only try once, not retry
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('should queue failed payments', async () => {
      const mockPost = jest.fn().mockRejectedValue({
        code: 'ECONNABORTED',
        message: 'timeout',
      });
      
      mockCreate.mockReturnValue({
        post: mockPost,
      });
      
      service = new PaymentGatewayService();
      
      try {
        await service.processPayment({
          amount: 100,
          currency: 'USD',
          customerId: 'cust_queue',
          orderId: 'order_queue',
        });
      } catch (error) {
        // Expected to fail
      }

      const status = service.getCircuitBreakerStatus();
      expect(status.queuedPayments).toBe(1);
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after threshold failures', async () => {
      const mockPost = jest.fn().mockRejectedValue({
        response: { status: 504, statusText: 'Gateway Timeout' },
      });
      
      mockCreate.mockReturnValue({
        post: mockPost,
      });
      
      service = new PaymentGatewayService();
      
      // Trigger 5 failures to open the circuit
      for (let i = 0; i < 5; i++) {
        try {
          await service.processPayment({
            amount: 100,
            currency: 'USD',
            customerId: `cust_${i}`,
            orderId: `order_${i}`,
          });
        } catch (error) {
          // Expected to fail
        }
      }

      const status = service.getCircuitBreakerStatus();
      expect(status.state).toBe('OPEN');
    });
  });
});
