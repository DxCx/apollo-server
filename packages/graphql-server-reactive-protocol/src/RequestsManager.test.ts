import { expect } from 'chai';
import { stub } from 'sinon';
import 'mocha';

import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLSchema,
  GraphQLInt,
  GraphQLNonNull,
  ExecutionResult,
} from 'graphql';
import * as graphqlRxjs from 'graphql-rxjs';
import { Scheduler, Observable, BehaviorSubject, Subject } from 'rxjs';
import { IObservable } from 'graphql-server-observable';

import {
  RGQL_MSG_START,
  RGQL_MSG_INIT,
  RGQL_MSG_INIT_SUCCESS,
  RGQL_MSG_DATA,
  RGQL_MSG_STOP,
  RGQL_MSG_ERROR,
  RGQL_MSG_COMPLETE,
  RGQLPacket,
  RGQLPacketData,
} from './messageTypes';
import { RequestsManager } from './RequestsManager';

const queryType = new GraphQLObjectType({
    name: 'QueryType',
    fields: {
        testString: {
            type: GraphQLString,
            resolve() {
                return 'it works';
            },
        },
        testError: {
            type: GraphQLString,
            resolve() {
                throw new Error('Secret error message');
            },
        },
    },
});

const subscriptionType = new GraphQLObjectType({
    name: 'SubscriptionType',
    fields: {
        testInterval: {
            type: GraphQLInt,
            args: {
              interval: {
                type: new GraphQLNonNull(GraphQLInt),
              },
            },
            resolve(root, args, ctx) {
                return Observable.interval(args['interval']);
            },
        },
    },
});

const schema = new GraphQLSchema({
    query: queryType,
    subscription: subscriptionType,
});

describe('RequestsManager', () => {
  function wrapToRx<T>(o: IObservable<T>) {
    return new Observable<T>((observer) => o.subscribe(observer));
  }

  function expectError(data: RGQLPacketData, message: string, forceId: boolean = true) {
    const reqId = Math.floor(Math.random() * 1000) + 1;
    const inputPacket = <RGQLPacket>{
      data: Object.assign({}, data, forceId ? { id : reqId } : {}),
    };
    const input = Observable.of(inputPacket);
    const expected = <RGQLPacketData[]> [
      Object.assign({
        type: RGQL_MSG_ERROR,
        payload: undefined,
        ...(inputPacket.data.id) ? { id: inputPacket.data.id } : {},
      }),
    ];

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      const e: Error = res[0].payload as Error;
      expect(e.message).to.be.equals(message);

      expected[0].payload = e;
      expect(res).to.deep.equal(expected);
    });

  }

  it('passes sanity', () => {
    expect(RequestsManager).to.be.a('function');
  });

  it('has working keepAlive once configured', () => {
    const input = new Subject();
    const testTime = 124;
    const keepAliveValue = 25;
    const expectedResults = Math.floor(testTime / keepAliveValue);
    const reqMngr = new RequestsManager({
      schema: undefined,
      executor: {
        executeReactive: () => undefined,
      },
      keepAlive: keepAliveValue,
    }, input.asObservable());

    return wrapToRx(reqMngr.responseObservable)
      .bufferWhen(() => Observable.interval(testTime))
      .take(1).toPromise().then((res) => {
      expect(res).to.deep.equal(Array(expectedResults).fill({data: { type: 'keepalive' }}));
    });
  });

  it('does not output keepAlive if not configured', () => {
    const input = new Subject();
    const testTime = 124;
    const reqMngr = new RequestsManager({
      schema: undefined,
      executor: {
        executeReactive: () => undefined,
      },
    }, input.asObservable());

    return wrapToRx(reqMngr.responseObservable)
      .bufferWhen(() => Observable.interval(testTime))
      .take(1).toPromise().then((res) => {
      expect(res).to.deep.equal([]);
    });
  });

  it('can handle simple requests', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `query { testString }`,
        },
      },
    }),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = [
      {
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testString: 'it works',
          },
        },
      },

      // finite result, the server sends complete.
      {
        id: 1,
        type: RGQL_MSG_COMPLETE,
      },
    ];

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
    });
  });

  it('returns error if invalid msg type sent', () => {
    return expectError({
      id: undefined,
      type: 'invalid' as any,
      payload: {
        query: `query { testString }`,
      },
    }, 'Request has invalid type');
  });

  it('returns error if no id sent for start', () => {
    return expectError({
      id: undefined,
      type: RGQL_MSG_START,
      payload: {
        query: `query { testString }`,
      },
    }, 'Request is missing id field', false);
  });

  it('returns error if no id sent for stop', () => {
    return expectError({
      id: undefined,
      type: RGQL_MSG_STOP,
      payload: {
        query: `query { testString }`,
      },
    }, 'Request is missing id field', false);
  });

  it('returns error if no type sent', () => {
    return expectError({
      id: undefined,
      type: undefined,
      payload: undefined,
    }, 'Request is missing type field');
  });

  it('returns error if no payload sent with start', () => {
    return expectError({
      id: undefined,
      type: RGQL_MSG_START,
      payload: undefined,
    }, 'Request is missing payload field');
  });

  it('returns error if no payload.query sent with start', () => {
    return expectError({
      id: undefined,
      type: RGQL_MSG_START,
      payload: {
      },
    }, 'Request is missing payload.query field');
  });

  it('returns error on batching', () => {
    return expectError({
      id: undefined,
      type: RGQL_MSG_START,
      payload: [{
        query: `query { testString }`,
      }, {
        query: `subscription { testInterval(interval: 10) }`,
      }],
    }, 'interface does does not support batching');
  });

  it('returns error if invalid variables sent', () => {
    return expectError({
      id: undefined,
      type: RGQL_MSG_START,
      payload: {
        query: `subscription interval($interval: Int!) { testInterval(interval: $interval) }`,
        // Invalid json
        variables: `{"interval": "aaaaaa}`,
      },
    }, 'Variables are invalid JSON.');
  });

  it('supports init packet', () => {
    const input = Observable.of({
      data: {
        type: RGQL_MSG_INIT,
        payload: {},
      },
    });

    const expected = [{
      type: RGQL_MSG_INIT_SUCCESS,
    }];

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
    });
  });

  it('supports rejection on init packet error', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        type: RGQL_MSG_INIT,
        payload: {},
      },
    }),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = {
      type: RGQL_MSG_ERROR,
      payload: undefined,
    };

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input, {
      onInit: () => false,
    });

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .toPromise().then((res) => {
      const e: Error = res.payload as Error;
      expect(e.message).to.be.equals('Prohibited connection!');

      expected.payload = e;
      expect(res).to.deep.equal(expected);
    });
  });

  it('rejects bad return value from onRequestStart', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `query { testString }`,
        },
      },
    }),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = {
      id: 1,
      type: RGQL_MSG_ERROR,
      payload: undefined,
    };

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input, {
      onRequestStart: (() => false) as any,
    });

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .toPromise().then((res) => {
      const e: Error = res.payload as Error;
      expect(e.message).to.be.equals('Invalid params returned from onRequestStart');

      expected.payload = e;
      expect(res).to.deep.equal(expected);
    });
  });

  it('rejects on exception from onRequestStop', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `query { testString }`,
        },
      },
    }),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = {
      id: 1,
      type: RGQL_MSG_ERROR,
      payload: undefined,
    };

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input, {
      onRequestStop: (requestId) => {
        throw new Error('onRequestStop test error');
      },
    });

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .toPromise().then((res) => {
      const e: Error = res.payload as Error;
      expect(e.message).to.be.equals('onRequestStop test error');

      expected.payload = e;
      expect(res).to.deep.equal(expected);
    });
  });

  it('doesn\'t fail if onDisconnect throws', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `query { testString }`,
        },
      },
    }),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = [
      {
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testString: 'it works',
          },
        },
      },

      // finite result, the server sends complete.
      {
        id: 1,
        type: RGQL_MSG_COMPLETE,
      },
    ];

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input, {
      onDisconnect: () => {
        throw new Error('onDisconnect error test');
      },
    });

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
    });
  });

  it('supports callbacks', () => {
    const initPayload = 'initString';
    let onDisconnectCalled = false;
    let onStartCalled = false;
    let onStopCalled = false;
    let actualyInitPayload;

    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        type: RGQL_MSG_INIT,
        payload: initPayload,
      },
    }),
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `subscription { testInterval(interval: 50) }`,
        },
      },
    }).delay(50),
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_STOP,
      },
    }).delay(124)]).concatAll();

    const expected: RGQLPacketData[] = [{
      type: RGQL_MSG_INIT_SUCCESS,
    }];
    for ( let i = 0 ; i < 2 ; i ++ ) {
      expected.push({
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testInterval: i,
          },
        },
      });
    }

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input, {
      onInit: (payload) => {
        actualyInitPayload = payload;
        return true;
      },
      onRequestStart: (requestId, requestParams) => {
        expect(requestId).to.be.equals(1);
        onStartCalled = true;
        return requestParams;
      },
      onRequestStop: (requestId) => {
        expect(requestId).to.be.equals(1);
        onStopCalled = true;
      },
      onDisconnect: () => {
        onDisconnectCalled = true;
      },
    });

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
      expect(actualyInitPayload).to.be.equals(initPayload);
      expect(onStartCalled).to.be.equals(true);
      expect(onStopCalled).to.be.equals(true);
      expect(onDisconnectCalled).to.be.equals(true);
    });
  });

  it('able to subscribe to changes', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `subscription { testInterval(interval: 25) }`,
        },
      },
    }),
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_STOP,
      },
    }).delay(124)]).concatAll();

    const expected = [];
    for ( let i = 0 ; i < 4 ; i ++ ) {
      expected.push({
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testInterval: i,
          },
        },
      });
    }

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
    });
  });

  it('able to subscribe with variables', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `subscription interval($interval: Int!) { testInterval(interval: $interval) }`,
          variables: `{"interval": 25}`,
        },
      },
    }),
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_STOP,
      },
    }).delay(120)]).concatAll();

    const expected = [];
    for ( let i = 0 ; i < 4 ; i ++ ) {
      expected.push({
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testInterval: i,
          },
        },
      });
    }

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
    });
  });

  it('runs formatParams if provided', () => {
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `query { testString }`,
        },
      },
    }),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = [
      {
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testString: 'it works',
          },
        },
      },
      {
        id: 1,
        type: RGQL_MSG_COMPLETE,
      },
    ];
    let requestParamsRun = false;

    const reqMngr = new RequestsManager({
      schema,
      formatParams: (p) => {
        requestParamsRun = true;
        return p;
      },
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(requestParamsRun).to.be.equals(true);
      expect(res).to.deep.equal(expected);
    });
  });

  it('able to preserve metadata', () => {
    const inputPacket: RGQLPacket = {
      metadata: 'packet-info',
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query: `query { testString }`,
        },
      },
    };
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of(inputPacket),
    // add delay to allow promises to resolve.
    Observable.empty().delay(100)]).concatAll();

    const expected = [{
        metadata: 'packet-info',
        data: {
          id: 1,
          type: RGQL_MSG_DATA,
          payload: {
            data: {
              testString: 'it works',
            },
          },
        },
    }, {
      metadata: 'packet-info',
      data: {
        id: 1,
        type: RGQL_MSG_COMPLETE,
      },
    }];

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .bufferCount(expected.length + 1)
      .toPromise().then((res) => {
      expect(res).to.deep.equal(expected);
    });
  });

  it('able to subscribe for more then one subscription in one', () => {
    const query = `subscription interval($interval: Int!) { testInterval(interval: $interval) }` ;
    const input = Observable.from(<Observable<RGQLPacket>[]>[
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_START,
        payload: {
          query,
          variables: { interval: 25 },
        },
      },
    }),
    Observable.of({
      data: {
        id: 2,
        type: RGQL_MSG_START,
        payload: {
          query,
          variables: { interval: 50 },
        },
      },
    }),
    Observable.of({
      data: {
        id: 1,
        type: RGQL_MSG_STOP,
      },
    }).delay(120),
    Observable.of({
      data: {
        id: 2,
        type: RGQL_MSG_STOP,
      },
    }).delay(120),
    ]).concatAll();

    const expected1 = [];
    for ( let i = 0 ; i < 4 ; i ++ ) {
      expected1.push({
        id: 1,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testInterval: i,
          },
        },
      });
    }

    const expected2 = [];
    for ( let i = 0 ; i < 4 ; i ++ ) {
      expected2.push({
        id: 2,
        type: RGQL_MSG_DATA,
        payload: {
          data: {
            testInterval: i,
          },
        },
      });
    }

    const reqMngr = new RequestsManager({
      schema,
      executor: graphqlRxjs,
    }, input);

    return wrapToRx(reqMngr.responseObservable)
      .map((v) => v.data)
      .groupBy((v) => v.id)
      .flatMap(group => group.reduce((acc, curr) => [...acc, curr], []))
      .bufferCount(2)
      .toPromise().then((res) => {
      expect(res).to.deep.equal([expected1, expected2]);
    });
  });
});
