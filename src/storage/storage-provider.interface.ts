// @types/multer augments the Express namespace globally with Multer.File
// so we use Express.Multer.File directly, without a custom import

export interface StorageProvider {
  uploadFile(file: Express.Multer.File): Promise<string>;
  deleteFile(fileUrl: string): Promise<void>;
}
