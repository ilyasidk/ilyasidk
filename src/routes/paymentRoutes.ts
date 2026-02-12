/**
 * Payment Routes
 */

import { Router } from 'express';
import { paymentController } from '../controllers/paymentController';

const router = Router();

// Process a payment
router.post('/payments', (req, res) => paymentController.processPayment(req, res));

// Retry failed payments
router.post('/payments/retry', (req, res) => paymentController.retryFailedPayments(req, res));

// Get payment gateway status
router.get('/payments/status', (req, res) => paymentController.getStatus(req, res));

export default router;
