import { expect, test } from '@playwright/test';
import { buyTShirt, expectFulfilled, logInToDashboard, payWithUpi } from './helpers';

test('buy → pay with success@test → fulfilled, and the dashboard shows it', async ({ page }) => {
  await buyTShirt(page);
  await payWithUpi(page, 'success@test');
  await expect(page.getByText('Payment successful')).toBeVisible();

  const paymentId = await expectFulfilled(page);

  // The merchant's view: the payment is captured and its webhook was delivered.
  await logInToDashboard(page, `/dashboard/payments/${paymentId}`);
  await expect(page.getByText('Captured', { exact: true }).first()).toBeVisible();
  const captured = page
    .getByRole('listitem')
    .filter({ has: page.getByText('payment.captured', { exact: true }) });
  await expect(
    captured.getByText('Succeeded', { exact: true }).filter({ visible: true }),
  ).toBeVisible();
});
