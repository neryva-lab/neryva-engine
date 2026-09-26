import { DynamicModule, Global, Module } from '@nestjs/common';
import { MongoDbService } from './mongo.service';

/**
 * MongoDB lane of the dual-persistence design (plan D1–D3). Global so domain
 * modules can inject `MongoDbService` exactly like `DbService`.
 *
 * Always registered (see AppModule): the service itself is inert when
 * `DB_PROVIDER=postgres` — it never opens a connection and its entry points
 * throw a clear provider-mismatch error. Dynamic `register()` keeps the door
 * open for per-module collection bindings later (plan D3 forRoot/forFeature
 * style) without touching this seam.
 */
@Global()
@Module({})
export class MongoDbModule {
  static register(): DynamicModule {
    return {
      module: MongoDbModule,
      providers: [MongoDbService],
      exports: [MongoDbService],
    };
  }
}
