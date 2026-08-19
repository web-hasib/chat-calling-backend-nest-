import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    // Handle NestJS Built-in HTTP Exceptions
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resContent: any = exception.getResponse();
      message = typeof resContent === 'object' ? resContent.message || exception.message : resContent;
    } 
    // Handle Prisma Database Client Errors
    else if (exception?.code) {
      status = HttpStatus.BAD_REQUEST;
      switch (exception.code) {
        case 'P2002': {
          const target = exception.meta?.target ? ` (${exception.meta.target.join(', ')})` : '';
          message = `Unique constraint failed: A record with this value already exists${target}.`;
          break;
        }
        case 'P2003': {
          message = 'Foreign key constraint failed: Related record not found.';
          break;
        }
        case 'P2025': {
          message = 'Record to update or delete not found.';
          break;
        }
        default: {
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          message = exception.message || 'Database error occurred.';
        }
      }
    } 
    // Handle Generic Errors (shows the actual descriptive error message instead of generic 500)
    else if (exception instanceof Error) {
      message = exception.message;
    }

    // Log the error detail in console for backend developers
    console.error(`[Exception] Path: ${request.url} | Status: ${status} | Message: ${message}`);
    if (exception && !(exception instanceof HttpException)) {
      console.error(exception.stack || exception);
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: Array.isArray(message) ? message.join(', ') : message, // join all messages if validation returns an array
    });
  }
}
