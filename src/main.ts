import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global Exception Filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // CORS: allow frontend on port 3000 (and any localhost during dev)
  app.enableCors({
    origin: '*',
    //   origin: [
    //   'http://localhost:3000',
    //   'http://localhost:3001',
    //   'https://231dpltn-3000.inc1.devtunnels.ms/',
    //   'http://127.0.0.1:3000',
    //   'http://127.0.0.1:5000',
    //   'https://ptzs5ctl-3000.asse.devtunnels.ms/',
    //   'http://localhost:3000',
    // ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });

  const port = process.env.PORT ?? 5000;
  await app.listen(port);
  console.log(`NestJS server running on: http://localhost:${port}`);
}
bootstrap();
