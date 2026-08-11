/**
 * Utility functions for standardized API responses
 */

// Success Response
export const successResponse = (
      res,
      message,
      data = null,
      statusCode = 200
) => {
      return res.status(statusCode).json({
            success: true,
            statusCode,
            message,
            data,
      });
};

// Error Response
export const errorResponse = (
      res,
      message,
      statusCode = 500
) => {
      return res.status(statusCode).json({
            success: false,
            statusCode,
            message,
            data: null,
      });
};