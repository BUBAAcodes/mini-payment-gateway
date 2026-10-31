import { expect, test } from '@playwright/test';
import { buyTShirt, expectFulfilled, payWithUpi } from './helpers';

test('a declined UPI payment, then a successful retry → fulfilled', async ({ page }) => {
  await buyTShirt(page);
  await payWithUpi(page, 'fail@test');
  await expect(page.getByRole('heading', { name: 'Not completed' })).toBeVisible();

  // A new attempt on the same order (section 9.1, step 8).
  await page.getByRole('button', { name: 'Try again' }).click();
  await payWithUpi(page, 'success@test');
  await expect(page.getByText('Payment successful')).toBeVisible();

  await expectFulfilled(page);
});
