import { wsApollo } from './wsApollo';
// import testSuite, { Schema, CreateAppOptions } from './integrations.test';
import { expect } from 'chai';
import ApolloOptions from './apolloOptions';

// function createApp(options: CreateAppOptions = {}) {
//   const app = express();
//
//   options.apolloOptions = options.apolloOptions || { schema: Schema };
//   if (!options.excludeParser) {
//     app.use('/graphql', bodyParser.json());
//   }
//   if (options.graphiqlOptions ) {
//     app.use('/graphiql', graphiqlExpress( options.graphiqlOptions ));
//   }
//   app.use('/graphql', apolloExpress( options.apolloOptions ));
//   return app;
// }

describe('wsApollo', () => {
  it('throws error if called without schema', function(){
     expect(() => wsApollo(undefined as ApolloOptions)).to.throw('Apollo Server requires options.');
  });

  it('throws an error if called with more than one argument', function(){
     expect(() => (<any>wsApollo)({}, 'x')).to.throw(
       'Apollo Server expects exactly one argument, got 2');
  });
});

// TODO: Discuess @helfer about testSuite for websocket.
// describe('integration:Websocket', () => {
//   testSuite(createApp);
// });
