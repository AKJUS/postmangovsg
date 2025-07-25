import cors from 'cors'
import { isCelebrate } from 'celebrate'
import express, { Request, Response, NextFunction } from 'express'
import expressWinston from 'express-winston'
import * as Sentry from '@sentry/node'
import tracer from 'dd-trace'

import config from '@core/config'
import { InitV1Route } from '@core/routes'
import { loggerWithLabel } from '@core/logger'
import { ensureAttachmentsFieldIsArray } from '@core/utils/attachment'
import helmet from 'helmet'
import {
  ApiMalformError,
  ApiValidationError,
  RestApiError,
} from '@core/errors/rest-api.errors'

const logger = loggerWithLabel(module)
const FRONTEND_URL = config.get('frontendUrl')

/**
 * Returns a regex or a string used by cors to determine if requests comes from allowed origin
 * @param v
 */
const origin = (v: string): string | RegExp => {
  if (v.startsWith('/') && v.endsWith('/')) {
    // Remove the leading and trailing slash
    return new RegExp(v.substring(1, v.length - 1))
  }
  return v
}

const sentrySessionMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (req.session?.user) {
    Sentry.setUser({ id: req.session?.user?.id })
  }
  if (req.session?.apiKey) {
    Sentry.setTag('usesApiKey', 'true')
  }
  next()
}

interface ErrorWithType extends Error {
  type: string
}
function isBodyParserError(error: ErrorWithType) {
  const bodyParserCommonErrorsTypes = [
    'encoding.unsupported',
    'entity.parse.failed',
    'entity.verify.failed',
    'request.aborted',
    'request.size.invalid',
    'stream.encoding.set',
    'parameters.too.many',
    'charset.unsupported',
    'entity.too.large',
  ]
  return bodyParserCommonErrorsTypes.includes(error.type)
}

export function celebrateErrorMiddleware(
  err: Error,
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction
) {
  if (isCelebrate(err)) {
    throw new ApiValidationError(err.message)
  } else if (err) {
    return next(err)
  }
  next()
}

export function bodyParserErrorMiddleware(
  err: Error,
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction
) {
  if (isBodyParserError(err as ErrorWithType)) {
    logger.info({
      message: 'Malformed request',
      error: {
        message: err.message,
        type: (err as ErrorWithType).type,
      },
    })
    throw new ApiMalformError('Malformed request body')
  } else if (err) {
    return next(err)
  }
  next()
}

export function restApiErrorMiddleware(
  err: Error,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): express.Response | void {
  if (err instanceof RestApiError) {
    return res.status(err.httpStatusCode).json({
      code: err.errorCode,
      message: err.message,
    })
  } else if (err) {
    return next(err)
  }
  next()
}

Sentry.init({
  dsn: config.get('sentryDsn'),
  environment: config.get('env'),
})

/**
 * SNS defaults the content-type header to 'content-type': 'text/plain; charset=UTF-8',
 * even though it is sending a json document, causing bodyParser to not work
 * @param req
 * @param _res
 * @param next
 */
const overrideContentTypeHeaderMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
): Response | void => {
  if (req.get('x-amz-sns-message-type')) {
    req.headers['content-type'] = 'application/json'
  }
  return next()
}

const expressApp = ({ app }: { app: express.Application }): void => {
  app.use(Sentry.Handlers.requestHandler())

  app.use(overrideContentTypeHeaderMiddleware)

  // We need to parse the body as text specifically for SendGrid callbacks.
  // This is to avoid stripping whitespace characters and messing with unicode encoding.
  // This route affects SES callbacks as well, so we'll need to parse the text as JSON
  // in the parseEvent() handle before parsing the SES event.
  app.use('/v1/callback/email', express.text({ type: 'application/json' }))

  app.use(
    express.json({
      // this must be significantly bigger than transactionalEmail.bodySizeLimit
      // so that users who exceed limit will trigger Joi validation rather than body-parser error
      // see https://github.com/opengovsg/postmangovsg/pull/2025
      limit: config.get('transactionalEmail.bodySizeLimit') * 10,
    })
  )
  app.use(
    express.urlencoded({
      extended: false,
      // this must be significantly bigger than transactionalEmail.bodySizeLimit
      // so that users who exceed limit will trigger Joi validation rather than body-parser error
      // see https://github.com/opengovsg/postmangovsg/pull/2025
      limit: config.get('transactionalEmail.bodySizeLimit') * 10,
    })
  )
  // ref: https://expressjs.com/en/resources/middleware/cors.html#configuration-options
  // Default CORS setting:
  // {
  //   "origin": "*",
  //   "methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
  //   "preflightContinue": false,
  //   "optionsSuccessStatus": 204
  // }
  app.use(
    cors({
      origin: origin(FRONTEND_URL),
      credentials: true, // required for setting cookie
    })
  )

  // Prevent browser caching on IE11
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-control', 'no-cache')
    // for HTTP1.0 backward compatibility
    res.setHeader('Pragma', 'no-cache')
    next()
  })

  app.use(
    expressWinston.logger({
      msg: `Incoming HTTP Request {{req.method}} {{req.url}}`,
      winstonInstance: logger,
      ignoredRoutes: ['/'],
      requestWhitelist: ['method', 'url', 'body', 'headers'],
      responseWhitelist: ['statusCode'],
      requestFilter: (req: Request, propName: string) => {
        // If body is undefined or null, normalize to empty object for safe access
        req.body = req.body || {}
        if (propName === 'headers' && req.headers.authorization) {
          // we do this instead of adding it to `headerBlacklist`
          // so we can distinguish if an API call is made via API key
          req.headers.authorization = '[REDACTED]'
        }
        if (propName === 'headers' && req.headers.cookie) {
          // redact cookies from logs
          // keep header to distinguish if API call is made via cookie
          req.headers.cookie = '[REDACTED]'
        }
        if (propName === 'body' && req.body.attachments) {
          const { attachments } = req.body
          req.body.attachments = ensureAttachmentsFieldIsArray(attachments).map(
            (attachment) => ({
              // truncate attachment data so the whole file won't get logged and take
              // up our disk space
              ...attachment,
              data: '[REDACTED]',
            })
          )
        }
        if (propName === 'body' && req.body.body) {
          // An example of req.body.body is the email body of an email that a user wishes to send
          // We should redact such content as it may contain sensitive information
          req.body.body = '[REDACTED]'
        }
        return (req as any)[propName]
      },
      metaField: null, // flatten this log to root instead of nesting under `meta`
    })
  )

  app.use(
    helmet({
      hsts: {
        maxAge: 31622400, // 366 days
      },
    })
  )
  app.get('/', async (_req: Request, res: Response) => {
    return res.sendStatus(200)
  })

  app.use(sentrySessionMiddleware)

  app.use('/v1', InitV1Route(app))
  app.use(celebrateErrorMiddleware)
  app.use(bodyParserErrorMiddleware)
  app.use(restApiErrorMiddleware)

  app.use(Sentry.Handlers.errorHandler())

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const traceId = tracer.scope().active()?.context().toTraceId()
      let message = 'Internal Server Error.'
      if (traceId) {
        message = `Internal Server Error. Please reach out to us with tracking ID ${traceId} for more info.`
      }
      logger.error({
        message: 'Unexpected error occured',
        error: {
          message: `${err.stack}`,
          parent: (err as any).parent,
          original: (err as any).original,
        },
      })
      return res.status(500).json({ code: 'internal_server', message })
    }
  )

  logger.info({ message: 'Express routes loaded' })
}

export default expressApp
