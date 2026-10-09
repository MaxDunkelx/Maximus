import { describe, expect, it } from 'vitest';
import { voiceCommand } from '../public/commands.js';

describe('voice commands', () => {
  it('recognizes only hide and rise', () => {
    expect(voiceCommand('Hide Maximus')).toBe('hide');
    expect(voiceCommand('hide, maximus.')).toBe('hide');
    expect(voiceCommand('please hyde maxim us')).toBe('hide');
    expect(voiceCommand('Rise Maximus')).toBe('rise');
    expect(voiceCommand('rize maximus')).toBe('rise');
    expect(voiceCommand('what is your profession')).toBeNull();
    expect(voiceCommand('hi maximus')).toBeNull();
    expect(voiceCommand('hide')).toBeNull();
  });
});
