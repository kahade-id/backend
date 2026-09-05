"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = exports.CircuitState = void 0;
const common_1 = require("@nestjs/common");
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
function defaultIsTransientError(error) {
    if (!error || typeof error !== 'object')
        return true;
    const err = error;
    const status = err?.status ?? err?.statusCode ?? err?.response?.statusCode;
    if (typeof status === 'number') {
        if (status >= 400 && status < 500)
            return false;
    }
    const code = err?.response?.code ?? err?.code;
    if (typeof code === 'string') {
        const businessCodes = [
            'BANK_ACCOUNT_NOT_FOUND',
            'CARD_TOKEN_REQUIRED',
            'INVALID_PAYMENT_METHOD',
        ];
        if (businessCodes.includes(code))
            return false;
    }
    const name = err?.name;
    if (name === 'BadRequestException' || name === 'NotFoundException' || name === 'ForbiddenException') {
        return false;
    }
    return true;
}
const DEFAULT_OPTIONS = {
    failureThreshold: 5,
    recoveryTimeMs: 30_000,
    halfOpenMaxAttempts: 1,
    name: 'CircuitBreaker',
};
class CircuitBreaker {
    constructor(options) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.halfOpenAttempts = 0;
        this.halfOpenInFlight = false;
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.isTransientError = this.options.isTransientError ?? defaultIsTransientError;
        this.logger = new common_1.Logger(this.options.name);
    }
    getState() {
        return this.state;
    }
    async execute(fn) {
        if (this.state === CircuitState.OPEN) {
            if (Date.now() - this.lastFailureTime >= this.options.recoveryTimeMs) {
                this.state = CircuitState.HALF_OPEN;
                this.halfOpenAttempts = 0;
                this.halfOpenInFlight = false;
                this.logger.warn(`${this.options.name}: Circuit transitioning from OPEN to HALF_OPEN`);
            }
            else {
                throw new common_1.ServiceUnavailableException({
                    code: 'SERVICE_CIRCUIT_OPEN',
                    message: 'Service temporarily unavailable. Please try again later.',
                });
            }
        }
        if (this.state === CircuitState.HALF_OPEN) {
            if (this.halfOpenInFlight || this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
                throw new common_1.ServiceUnavailableException({
                    code: 'SERVICE_CIRCUIT_OPEN',
                    message: 'Service temporarily unavailable. Please try again later.',
                });
            }
            this.halfOpenInFlight = true;
            this.halfOpenAttempts++;
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (error) {
            if (this.isTransientError(error)) {
                this.onTransientFailure();
            }
            else {
                if (this.state === CircuitState.HALF_OPEN) {
                    this.onSuccess();
                }
            }
            throw error;
        }
    }
    onSuccess() {
        if (this.state === CircuitState.HALF_OPEN) {
            this.logger.log(`${this.options.name}: Circuit transitioning from HALF_OPEN to CLOSED`);
        }
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
        this.halfOpenInFlight = false;
        this.state = CircuitState.CLOSED;
    }
    onTransientFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.state === CircuitState.HALF_OPEN) {
            this.halfOpenInFlight = false;
            this.state = CircuitState.OPEN;
            this.logger.error(`${this.options.name}: Circuit transitioning from HALF_OPEN to OPEN after probe failure`);
            return;
        }
        if (this.failureCount >= this.options.failureThreshold) {
            this.state = CircuitState.OPEN;
            this.logger.error(`${this.options.name}: Circuit OPENED after ${this.failureCount} consecutive failures`);
        }
    }
    reset() {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
        this.halfOpenInFlight = false;
        this.logger.log(`${this.options.name}: Circuit manually reset to CLOSED`);
    }
}
exports.CircuitBreaker = CircuitBreaker;
