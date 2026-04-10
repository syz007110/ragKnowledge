import { test, expect } from '@playwright/test';
import { login } from './helpers/login.js';

test.describe('Vue + API', () => {
  test('login redirects to workspace', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/workspace/);
  });
});
