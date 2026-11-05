import type { Response } from 'supertest';
import type {
  ApiSuccessResponse,
  ApiErrorResponse,
} from '../../src/common/interfaces/api-response.interface';

export type JsonResponse<T> = Omit<Response, 'body'> & { body: T };
export type SuccessResponse<T> = JsonResponse<ApiSuccessResponse<T>>;
export type ErrorResponse = JsonResponse<ApiErrorResponse>;
