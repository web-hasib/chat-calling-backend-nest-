import { Module } from '@nestjs/common';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { CloudinaryStorageProvider } from './cloudinary-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'StorageProvider',
      useFactory: (configService: ConfigService) => {
        const provider = configService.get<string>('STORAGE_PROVIDER', 'cloudinary');
        if (provider === 's3') {
          return new S3StorageProvider(configService);
        }
        return new CloudinaryStorageProvider(configService);
      },
      inject: [ConfigService],
    },
  ],
  exports: ['StorageProvider'],
})
export class StorageModule {}
