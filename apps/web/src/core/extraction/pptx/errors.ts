export type PptxErrorCode =
  /** Not a zip, or the central directory is corrupt. */
  | 'not_zip'
  /** OLE compound file (D0 CF 11 E0 A1 B1 1A E1): a password-protected PPTX or a legacy .ppt. */
  | 'encrypted'
  /** A zip-bomb cap was hit. */
  | 'zip_limits'
  /** Duplicate wanted entry name, or an unsupported compression method on a wanted entry. */
  | 'zip_entry'
  /** No ppt/presentation.xml. */
  | 'not_pptx'
  /** A relationship points at a part that is not in the zip. */
  | 'missing_part'
  /** Invalid UTF-8/UTF-16, validator error, DOCTYPE, nesting limit, or a parser throw. */
  | 'malformed_xml'
  /** Unexpected root element or non-canonical namespace prefixes. */
  | 'unsupported';

/** The only error type the PPTX reader throws for bad input, so callers can fall back instead of crashing. */
export class PptxError extends Error {
  readonly name = 'PptxError';
  constructor(
    readonly code: PptxErrorCode,
    message: string,
    readonly part?: string,
  ) {
    super(message);
  }
}
