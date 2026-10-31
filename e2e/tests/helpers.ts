import { expect, type Page } from '@playwright/test';
import { urls } from '../stack/compose';

export { urls };

/** Demo store: buy the T-shirt and follow the redirect to our checkout page. */
export async function buyTShirt(page: Page) {
  await page.goto(urls.store);
  await page.getByRole('button', { name: 'Buy now' }).click();
  await page.waitForURL(`${urls.web}/pay/**`);
  // Rule 13: checkout always says it is test mode.
  await expect(page.getByRole('note')).toContainText('Never enter real card details');
}

export async function payWithUpi(page: Page, vpa: string) {
  await page.getByRole('tab', { name: 'UPI' }).click();
  await page.getByLabel('UPI ID').fill(vpa);
  await page.getByRole('button', { name: /^Pay / }).click();
}

export async function payWithCard(page: Page, number: string) {
  await page.getByRole('tab', { name: 'Card' }).click();
  await page.getByLabel('Card number').fill(number);
  await page.getByLabel('Expiry').fill('12/30');
  await page.getByLabel('Name on card').fill('Test Customer');
  await page.getByRole('button', { name: /^Pay / }).click();
}

/**
 * After a successful payment, checkout sends the customer back to the store, whose order page
 * reloads itself until the payment.captured webhook arrives. Returns the payment ID it shows.
 */
export async function expectFulfilled(page: Page): Promise<string> {
  await page.waitForURL(`${urls.store}/orders/**`);
  await expect(page.getByRole('status')).toContainText('Fulfilled');
  const paymentId = await page.locator('code', { hasText: /^pay_/ }).textContent();
  expect(paymentId).toMatch(/^pay_[0-9A-Za-z]{14}$/);
  return paymentId!;
}

/** Logs in to the dashboard as the seeded demo merchant, landing on `next`. */
export async function logInToDashboard(page: Page, next: string) {
  await page.goto(`${urls.web}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(process.env.E2E_LOGIN_EMAIL!);
  await page.getByLabel('Password').fill(process.env.E2E_LOGIN_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(`${urls.web}${next}`);
}
