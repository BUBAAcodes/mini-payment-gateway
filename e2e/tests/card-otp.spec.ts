import { expect, test } from '@playwright/test';
import { buyTShirt, expectFulfilled, payWithCard } from './helpers';

test('card payment with an OTP → fulfilled', async ({ page }) => {
  await buyTShirt(page);
  await payWithCard(page, '4111 1111 1111 1111');

  // The OTP submits itself once all six digits are in.
  await page.getByLabel('One-time password').fill('123456');
  await expect(page.getByText('Payment successful')).toBeVisible();

  await expectFulfilled(page);
});
