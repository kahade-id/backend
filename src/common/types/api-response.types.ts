export interface ApiSuccessResponse<T> {
  success: true;
  message: string;
  data: T;
  errors: null;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  data: null;
  errors: {
    code: string;
    message?: string;
    details?: string[];
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface PaginatedData<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}
