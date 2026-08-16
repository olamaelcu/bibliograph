import { describe, expect, it } from 'vitest';
import { InterruptedError, abortReason, signalExitCode } from './interrupt.js';

describe('interrupt helpers', () => {
	it('exposes the signal exit codes for SIGINT and SIGTERM', () => {
		expect(signalExitCode('SIGINT')).toBe(130);
		expect(signalExitCode('SIGTERM')).toBe(143);
	});

	it('abortReason returns the InterruptedError reason when aborted', () => {
		const controller = new AbortController();
		controller.abort(new InterruptedError('SIGINT'));
		expect(abortReason(controller.signal)).toBeInstanceOf(InterruptedError);
	});

	it('abortReason returns a non-null reason when aborted without one', () => {
		const controller = new AbortController();
		controller.abort();
		expect(abortReason(controller.signal)).not.toBeNull();
	});

	it('abortReason returns null when not aborted', () => {
		expect(abortReason(new AbortController().signal)).toBeNull();
		expect(abortReason(undefined)).toBeNull();
	});
});
