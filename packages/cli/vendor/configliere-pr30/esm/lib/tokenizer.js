export class Tokenizer {
    constructor(tokens, claimed = new Set()) {
        Object.defineProperty(this, "tokens", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "claimed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.tokens = tokens;
        this.claimed = new Set(claimed);
    }
    claimNext() {
        return this.claimOne(() => true);
    }
    claimOne(match) {
        for (let token of this) {
            if (match(token)) {
                return {
                    tokens: [token],
                    rest: remainder(this, [token.index]),
                };
            }
        }
        return { tokens: [], rest: this };
    }
    claimPair(match) {
        let previous;
        for (let token of this) {
            if (!previous) {
                previous = token;
                continue;
            }
            if (token.index === previous.index + 1 && match(previous, token)) {
                return {
                    tokens: [previous, token],
                    rest: remainder(this, [previous.index, token.index]),
                };
            }
            previous = token;
        }
        return { tokens: [], rest: this };
    }
    claimAll(match) {
        let tokens = [];
        let claimed = new Set();
        for (let token of this) {
            if (match(token)) {
                claimed.add(token.index);
                tokens.push(token);
            }
        }
        return {
            tokens,
            rest: tokens.length > 0 ? remainder(this, claimed) : this,
        };
    }
    view(options) {
        return new View(this, options);
    }
    *[Symbol.iterator]() {
        for (let token of this.tokens) {
            if (!this.claimed.has(token.index)) {
                yield token;
            }
        }
    }
}
class View {
    constructor(source, options) {
        Object.defineProperty(this, "source", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: source
        });
        Object.defineProperty(this, "options", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: options
        });
    }
    claimNext() {
        return this.claimOne(() => true);
    }
    claimOne(match) {
        for (let token of this) {
            if (match(token)) {
                return {
                    tokens: [token],
                    rest: remainder(this.source, [token.index]),
                };
            }
        }
        return { tokens: [], rest: this.source };
    }
    claimPair(match) {
        let previous;
        for (let token of this) {
            if (!previous) {
                previous = token;
                continue;
            }
            if (token.index === previous.index + 1 && match(previous, token)) {
                return {
                    tokens: [previous, token],
                    rest: remainder(this.source, [previous.index, token.index]),
                };
            }
            previous = token;
        }
        return { tokens: [], rest: this.source };
    }
    claimAll(match) {
        let tokens = [];
        let claimed = new Set();
        for (let token of this) {
            if (match(token)) {
                claimed.add(token.index);
                tokens.push(token);
            }
        }
        return {
            tokens,
            rest: tokens.length > 0 ? remainder(this.source, claimed) : this.source,
        };
    }
    *[Symbol.iterator]() {
        let { start, end } = this.options.range;
        let { through } = this.options;
        for (let token of this.source) {
            if (token.index > start &&
                (end === undefined || token.index < end) &&
                (through === undefined || token.index <= through)) {
                yield token;
            }
        }
    }
}
function remainder(source, claimed) {
    return new Tokenizer(source.tokens, new Set([...source.claimed, ...claimed]));
}
//# sourceMappingURL=tokenizer.js.map