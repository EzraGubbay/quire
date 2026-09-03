import { isAllowedLogin } from './allowed-login';

describe('isAllowedLogin', () => {
  it('matches the configured login case-insensitively', () => {
    expect(isAllowedLogin('ezragubbay', 'EzraGubbay')).toBe(true);
    expect(isAllowedLogin('EzraGubbay', 'EzraGubbay')).toBe(true);
  });
  it('rejects other logins, empty values, and an unset allow-list', () => {
    expect(isAllowedLogin('someone-else', 'EzraGubbay')).toBe(false);
    expect(isAllowedLogin('', 'EzraGubbay')).toBe(false);
    expect(isAllowedLogin(undefined, 'EzraGubbay')).toBe(false);
    expect(isAllowedLogin('EzraGubbay', '')).toBe(false);
  });
});
