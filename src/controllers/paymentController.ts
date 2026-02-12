/**
 * Payment Controller
 * 
 * Handles HTTP requests for payment processing
 */

import { Request, Response } from 'express';
import { paymentGateway } from '../services/paymentGateway';

export class PaymentController {
  /**
   * Process a payment request
   */
  async processPayment(req: Request, res: Response): Promise<void> {
    try {
      const { amount, currency, customerId, orderId, metadata } = req.body;

      // Validate required fields
      if (!amount || !currency || !customerId || !orderId) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: amount, currency, customerId, orderId',
        });
        return;
      }

      // Process the payment
      const result = await paymentGateway.processPayment({
        amount,
        currency,
        customerId,
        orderId,
        metadata,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('[PaymentController] Payment processing error:', error);
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      res.status(500).json({
        success: false,
        error: errorMessage,
        message: 'Payment processing failed. The request has been queued for retry.',
      });
    }
  }

  /**
   * Retry failed payments
   */
  async retryFailedPayments(req: Request, res: Response): Promise<void> {
    try {
      await paymentGateway.retryFailedPayments();
      
      res.status(200).json({
        success: true,
        message: 'Failed payments retry initiated',
      });
    } catch (error) {
      console.error('[PaymentController] Retry failed payments error:', error);
      
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get payment gateway status
   */
  async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = paymentGateway.getCircuitBreakerStatus();
      
      res.status(200).json({
        success: true,
        data: status,
      });
    } catch (error) {
      console.error('[PaymentController] Get status error:', error);
      
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

export const paymentController = new PaymentController();
