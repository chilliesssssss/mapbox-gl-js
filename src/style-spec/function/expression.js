// @flow

import type {
    Type,
} from './types';
const {
    NullType,
    NumberType,
    StringType,
    BooleanType,
    ObjectType,
    ColorType,
    ValueType,
    array,
    toString
} = require('./types');

export interface Expression {
    key: string;
    +type: Type;

    static parse(args: Array<mixed>, context: ParsingContext): ?Expression; // eslint-disable-line no-use-before-define

    compile(): string;

    serialize(): any;
    accept(Visitor<Expression>): void;
}

class ParsingError extends Error {
    key: string;
    message: string;
    constructor(key: string, message: string) {
        super(message);
        this.message = message;
        this.key = key;
    }
}

/**
 * Tracks `let` bindings during expression parsing.
 * @private
 */
class Scope {
    parent: ?Scope;
    bindings: {[string]: Expression};
    constructor(parent?: Scope, bindings: Array<[string, Expression]> = []) {
        this.parent = parent;
        this.bindings = {};
        for (const [name, expression] of bindings) {
            this.bindings[name] = expression;
        }
    }

    concat(bindings: Array<[string, Expression]>) {
        return new Scope(this, bindings);
    }

    get(name: string): Expression {
        if (this.bindings[name]) { return this.bindings[name]; }
        if (this.parent) { return this.parent.get(name); }
        throw new Error(`${name} not found in scope.`);
    }

    has(name: string): boolean {
        if (this.bindings[name]) return true;
        return this.parent ? this.parent.has(name) : false;
    }
}

/**
 * State associated parsing at a given point in an expression tree.
 * @private
 */
class ParsingContext {
    definitions: {[string]: Class<Expression>};
    path: Array<number>;
    key: string;
    scope: Scope;
    errors: Array<ParsingError>;

    // The expected type of this expression. Provided only to allow Expression
    // implementations to infer argument types: Expression#parse() need not
    // check that the output type of the parsed expression matches
    // `expectedType`.
    expectedType: ?Type;

    constructor(
        definitions: *,
        path: Array<number> = [],
        expectedType: ?Type,
        scope: Scope = new Scope(),
        errors: Array<ParsingError> = []
    ) {
        this.definitions = definitions;
        this.path = path;
        this.key = path.map(part => `[${part}]`).join('');
        this.scope = scope;
        this.errors = errors;
        this.expectedType = expectedType;
    }

    /**
     * Returns a copy of this context suitable for parsing the subexpression at
     * index `index`, optionally appending to 'let' binding map.
     *
     * Note that `errors` property, intended for collecting errors while
     * parsing, is copied by reference rather than cloned.
     * @private
     */
    concat(index: number, expectedType?: ?Type, bindings?: Array<[string, Expression]>) {
        const path = typeof index === 'number' ? this.path.concat(index) : this.path;
        const scope = bindings ? this.scope.concat(bindings) : this.scope;
        return new ParsingContext(
            this.definitions,
            path,
            expectedType || null,
            scope,
            this.errors
        );
    }

    /**
     * Push a parsing (or type checking) error into the `this.errors`
     * @param error The message
     * @param keys Optionally specify the source of the error at a child
     * of the current expression at `this.key`.
     * @private
     */
    error(error: string, ...keys: Array<number>) {
        const key = `${this.key}${keys.map(k => `[${k}]`).join('')}`;
        this.errors.push(new ParsingError(key, error));
        return null;
    }
}

/**
 * Parse the given JSON expression.
 *
 * @param expectedType If provided, the parsed expression will be checked
 * against this type.  Additionally, `expectedType` will be pssed to
 * Expression#parse(), wherein it may be used to infer child expression types
 *
 * @private
 */
function parseExpression(expr: mixed, context: ParsingContext): ?Expression {
    if (expr === null || typeof expr === 'string' || typeof expr === 'boolean' || typeof expr === 'number') {
        expr = ['literal', expr];
    }

    if (Array.isArray(expr)) {
        if (expr.length === 0) {
            return context.error(`Expected an array with at least one element. If you wanted a literal array, use ["literal", []].`);
        }

        const op = expr[0];
        if (typeof op !== 'string') {
            context.error(`Expression name must be a string, but found ${typeof op} instead. If you wanted a literal array, use ["literal", [...]].`, 0);
            return null;
        }

        const Expr = context.definitions[op];
        if (Expr) {
            const parsed = Expr.parse(expr, context);
            if (!parsed) return null;
            if (context.expectedType && checkSubtype(context.expectedType, parsed.type, context)) {
                return null;
            } else {
                return parsed;
            }
        }

        return context.error(`Unknown expression "${op}". If you wanted a literal array, use ["literal", [...]].`, 0);
    } else if (typeof expr === 'undefined') {
        return context.error(`'undefined' value invalid. Use null instead.`);
    } else if (typeof expr === 'object') {
        return context.error(`Bare objects invalid. Use ["literal", {...}] instead.`);
    } else {
        return context.error(`Expected an array, but found ${typeof expr} instead.`);
    }
}

/**
 * Returns null if the type matches, or an error message if not.
 *
 * If `context` is provided, then also push the error to it via
 * `context.error()`
 *
 * @private
 */
function checkSubtype(
    expected: Type,
    t: Type,
    context?: ParsingContext
): ?string {
    const error = `Expected ${toString(expected)} but found ${toString(t)} instead.`;

    // Error is a subtype of every type
    if (t.kind === 'Error') {
        return null;
    }

    if (expected.kind === 'Value') {
        if (t.kind === 'Value') return null;
        const members = [
            NullType,
            NumberType,
            StringType,
            BooleanType,
            ColorType,
            ObjectType,
            array(ValueType)
        ];

        for (const memberType of members) {
            if (!checkSubtype(memberType, t)) {
                return null;
            }
        }

        if (context) context.error(error);
        return error;
    } else if (expected.kind === 'Array') {
        if (t.kind === 'Array') {
            const itemError = checkSubtype(expected.itemType, t.itemType);
            if (itemError) {
                if (context) context.error(error);
                return error;
            } else if (typeof expected.N === 'number' && expected.N !== t.N) {
                if (context) context.error(error);
                return error;
            } else {
                return null;
            }
        } else {
            if (context) context.error(error);
            return error;
        }
    } else {
        if (t.kind === expected.kind) return null;
        if (context) context.error(error);
        return error;
    }
}

module.exports = {
    Scope,
    ParsingContext,
    ParsingError,
    parseExpression,
    checkSubtype
};