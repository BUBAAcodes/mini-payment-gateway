import { describe, expect, it } from 'vitest';
import { cardLast4, cardNetwork, isLuhnValid } from './cards';

describe('isLuhnValid', () => {
  it.each([
    '4111111111111111', // the approve test card
    '4000000000000002', // the decline test card
    '5555555555554444',
    '2223003122003222',
    '378282246310005', // 15-digit amex
    '6080000000000000',
  ])('accepts %s', (number) => {
    expect(isLuhnValid(number)).toBe(true);
  });

  it.each([
    ['a wrong check digit', '4111111111111112'],
    ['letters', '4111abcd11111111'],
    ['spaces', '4111 1111 1111 1111'],
    ['too few digits', '42424242424'],
    ['too many digits', '41111111111111111111'],
    ['an empty string', ''],
  ])('rejects %s', (_name, number) => {
    expect(isLuhnValid(number)).toBe(false);
  });
});

describe('cardNetwork', () => {
  it.each([
    ['4111111111111111', 'visa'],
    ['5555555555554444', 'mastercard'],
    ['2223003122003222', 'mastercard'],
    ['378282246310005', 'amex'],
    ['6080000000000000', 'rupay'],
    ['9000000000000000', 'unknown'],
  ])('%s is %s', (number, network) => {
    expect(cardNetwork(number)).toBe(network);
  });
});

describe('cardLast4', () => {
  it('keeps only the last four digits', () => {
    expect(cardLast4('4000000000000002')).toBe('0002');
  });
});
