export type CandidateErrorCode = 'blocked' | 'bundle-mismatch' | 'installer-mismatch' | 'native-version-mismatch' | 'not-newer' | 'platform-mismatch' | 'withdrawn'

export type ChannelErrorCode = 'channel-expired' | 'channel-mismatch' | 'channel-replayed'
export type DocumentErrorCode = 'duplicate-path' | 'invalid-json' | 'invalid-schema' | 'unsafe-path'
/** Codes of the specification. Every client implementation reports the same code for the same input. */
export type ErrorCode = CandidateErrorCode | ChannelErrorCode | DocumentErrorCode | SignatureErrorCode
export type SignatureErrorCode = 'invalid-signature' | 'untrusted-key'

/** A document or a release that the protocol rejects. `code` comes from the specification. */
export class ErgosphereError<Code extends ErrorCode = ErrorCode> extends Error {
  readonly code: Code
  override name = 'ErgosphereError'

  constructor(code: Code, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** A verified bundle or installer that this install cannot take. */
export class CandidateError extends ErgosphereError<CandidateErrorCode> {
  override name = 'CandidateError'
  readonly releaseId: number

  constructor(code: CandidateErrorCode, message: string, releaseId: number, options?: ErrorOptions) {
    super(code, message, options)
    this.releaseId = releaseId
  }
}

/** The channel file is for another channel, has expired, or is older than one the client accepted. */
export class ChannelError extends ErgosphereError<ChannelErrorCode> {
  override name = 'ChannelError'
}

/** The document is not valid JSON, does not match its schema, or lists unsafe or duplicate paths. */
export class DocumentError extends ErgosphereError<DocumentErrorCode> {
  override name = 'DocumentError'
  readonly path: string | undefined

  constructor(code: DocumentErrorCode, message: string, path?: string, options?: ErrorOptions) {
    super(code, message, options)
    this.path = path
  }
}

/** The signature is not valid, or no trusted key made it. */
export class SignatureError extends ErgosphereError<SignatureErrorCode> {
  readonly keyId: string | undefined
  override name = 'SignatureError'

  constructor(code: SignatureErrorCode, message: string, keyId?: string, options?: ErrorOptions) {
    super(code, message, options)
    this.keyId = keyId
  }
}
