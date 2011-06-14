(function (require, exports) {

var Q = require("q");

var has = Object.prototype.hasOwnProperty;

// replicate the Q API
for (var name in Q) {
    if (has.call(Q, name)) {
        exports[name] = Q[name];
    }
}

// Copyright (C) 2010 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * An infinite queue where (promises for) values can be dequeued 
 * before they are enqueued.
 * 
 * Based on a similar example in Flat Concurrent Prolog, perhaps by
 * Ehud (Udi) Shapiro.
 * 
 * @author Mark S. Miller
 */

exports.Queue = Queue;
function Queue() {
    var ends = Q.defer();
    var closed = Q.defer();
    return {
        "put": function (value) {
            var next = Q.defer();
            ends.resolve({
                "head": value,
                "tail": next.promise
            });
            ends.resolve = next.resolve;
        },
        "get": function () {
            var result = Q.get(ends.promise, "head");
            ends.promise = Q.get(ends.promise, "tail");
            return Q.when(result, null, function (reason) {
                closed.resolve();
                return Q.reject(reason);
            });
            return result;
        },
        "closed": closed.promise,
        "close": function (reason) {
            var end = {"head": Q.reject(reason)};
            end.tail = end;
            ends.resolve(end);
            return closed.promise;
        }
    };
}

exports.join = function () {
    var values = Array.prototype.slice.call(arguments);
    var fulfilled = values.pop();
    var reasons;
    var fulfillment = Q.defer();
    var completion = values.reduce(function (done, value, i) {
        return Q.when(done, function () {
            return Q.when(value, function (value) {
                values[i] = value;
            }, function (reason) {
                reasons = reasons || [];
                reasons[i] = reason;
                fulfillment.reject(reason);
            });
        });
    }, undefined);
    Q.when(completion, fulfillment.resolve);
    return Q.when(fulfillment.promise, function () {
        return fulfilled ? fulfilled.apply(null, values) : values;
    }, function () {
        reasons = reasons || [];
        return Q.reject({
            "toString": function () {
                return "Can't join. " + reasons.join("; ");
            },
            "reasons": Q.when(completion, function () {
                return reasons;
            }),
            "stack": reasons.reduce(function (prev, next) {
                return prev || next;
            }).stack
        });
    });
};

/**
 * Calls each step function serially, proceeding only when
 * the promise returned by the previous step is deeply
 * resolved (see: `deep`), and passes the resolution of the
 * previous step into the argument or arguments of the
 * subsequent step.
 * 
 * If a step accepts more than one argument, the resolution
 * of the previous step is treated as an array and expanded
 * into the step's respective arguments.
 *
 * `step` returns a promise for the value eventually
 * returned by the last step.
 *
 * @param {Array * f(x):Promise}
 * @returns {Promise}
 */
exports.step = function () {
    return Array.prototype.reduce.call(
        arguments,
        function (value, callback) {
            return Q.when(deep(value), function (value) {
                if (callback.length > 1) {
                    return callback.apply(undefined, value);
                } else {
                    return callback(value);
                }
            });
        },
        undefined
    );
};

/**
 * Returns a promise for the eventual value after `timeout`
 * miliseconds have elapsed.  `eventually` may be omitted,
 * in which case the promise will be resolved to
 * `undefined`.  If `eventually` is a function, progress
 * will be made by calling that function and resolving to
 * the returned value.  Otherwise, `eventually` is treated
 * as a literal value and resolves the returned promise
 * directly.
 *
 * @param {Number} timeout
 * @returns {Promise * undefined} a promise for `undefined`
 * that will resolve after `timeout` miliseconds.
 */
exports.delay = function (timeout, eventually) {
    var deferred = Q.defer();
    setTimeout(deferred.resolve, timeout);
    if (typeof eventually === "undefined") {
        return deferred.promise;
    } else if (typeof eventually === "function") {
        return Q.when(deferred.promise, eventually);
    } else {
        return Q.when(deferred.promise, function () {
            return eventually;
        });
    }
};

/**
 * Takes any value and returns a promise for the
 * corresponding value after all of its properties have
 * been resolved.  For arrays, this means that the
 * resolution is a new array with the corresponding values
 * for each respective promise of the original array, and
 * for objects, a new object with the corresponding values
 * for each property.
 */
exports.shallow = shallow;
function shallow(object) {
    return consolidate(object, function (value) {
        return value;
    });
}

/**
 * Takes any value and returns a promise for the
 * corresponding value after all of its properties have
 * been deeply resolved.  Any array or object in the
 * transitive properties of the given value will be
 * replaced with a new array or object where all of the
 * owned properties have been replaced with their
 * resolution.
 */
exports.deep = deep;
function deep(object) {
    return consolidate(object, deep);
}

function consolidate(object, deep) {
    return Q.when(object, function (object) {
        if (
            typeof object !== "object" ||
            object === null ||
            object instanceof Date
        ) {
            return object;
        } else {
            var synchronize;
            for (var i in object) {
                (function (i, value) {
                    synchronize = Q.when(synchronize, function () {
                        return Q.when(deep(value), function (value) {
                            object[i] = value;
                        });
                    });
                })(i, object[i]);
            }
            return Q.when(synchronize, function () {
                return object;
            });
        }
    });
}


/**
 *  The reduce methods all have the signature of `reduce` on
 *  an ECMAScript 5 `Array`, but handle the cases where a
 *  value is a promise and when the return value of the
 *  accumulator is a promise.  In these cases, each reducer
 *  guarantees that progress will be made in a particular
 *  order.
 *
 * `reduceLeft` guarantees that the callback will be called
 * on each value and accumulation from left to right after
 * all previous values and accumulations are fully
 * resolved.
 */
var reduceLeft = exports.reduceLeft = reducer('reduce');

/**
 * `reduceRight` works similarly to `reduceLeft` but from
 * right to left.
 */
var reduceRight = exports.reduceRight = reducer('reduceRight');

function reducer(direction) {
    return function (values, callback, basis, that) {
        return Q.when(that, function (that) {
            return Q.when(values, function (values) {
                return values[direction](function (values, value) {
                    return Q.when(values, function (values) {
                        return Q.when(value, function (value) {
                            return callback.call(that, values, value);
                        });
                    });
                }, basis);
            });
        });
    }
}

/**
 * `reduce` is opportunistic and will attempt to accumulate
 * the resolution of any previous resolutions.  This is
 * useful when the accumulation function is associative.
 */
exports.reduce = reduce;
function reduce(values, callback, accumulator, that) {
    var accumulators = [];
    if (arguments.length > 2)
        accumulators.push(accumulator);
    var reduction = Q.defer();

    Q.when(Q.shallow(UTIL.map(values, function (value) {
        return Q.when(value, function (value) {
            accumulators.push(value);
            reduce();
        });
    })), function () {
        // assert accumulators.length == 1
        reduction.resolve(accumulators.shift());
    }, function (reason) {
        reduction.reject({
            "child": reason
        });
    });

    function reduce() {
        if (accumulators.length < 2)
            return;
        Q.when(callback.call(
            that,
            accumulators.shift(),
            accumulators.shift()
        ), function (value) {
            accumulators.push(value);
            reduce();
        }, function (reason) {
            reduction.reject({
                "message": "error in reduction",
                "child": reason
            });
        });
    }

    return reduction.promise;
}

exports.Lazy = function (constructor, promise) {
    var prototype = constructor.prototype;
    var result = exports.defer();
    result.resolve(promise);
    var proxy = Object.create(result.promise);
    var forward = function (name) {
        proxy[name] = function () {
            var args = Array.prototype.slice.call(arguments);
            return Q.post(result.promise, name, args);
        };
    };
    if (Array.isArray(constructor)) {
        constructor.forEach(forward);
    } else {
        while (prototype !== Object.prototype) {
            Object.getOwnPropertyNames(prototype).forEach(function (name) {
                if (typeof prototype[name] === "function") {
                    forward(name);
                }
            });
            prototype = Object.getPrototypeOf(prototype);
        }
    }
    return proxy;
};

// boilerplate that permits this module to be used as a
// <script> in less-than-ideal situations.
}).apply(this, typeof exports !== "undefined" ? [
    require, exports
] : [
    function () {
        return Q;
    },
    QQ = {}
]);
