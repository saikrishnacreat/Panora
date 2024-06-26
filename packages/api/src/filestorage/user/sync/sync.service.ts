import { Injectable, OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@@core/@core-services/logger/logger.service';
import { PrismaService } from '@@core/@core-services/prisma/prisma.service';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { ServiceRegistry } from '../services/registry.service';
import { WebhookService } from '@@core/@core-services/webhooks/panora-webhooks/webhook.service';
import { CoreSyncRegistry } from '@@core/@core-services/registries/core-sync.registry';
import { ApiResponse } from '@@core/utils/types';
import { IUserService } from '../types';
import { OriginalUserOutput } from '@@core/utils/types/original/original.file-storage';
import { UnifiedUserOutput } from '../types/model.unified';
import { fs_users as FileStorageUser } from '@prisma/client';
import { FILESTORAGE_PROVIDERS } from '@panora/shared';
import { FileStorageObject } from '@filestorage/@lib/@types';
import { BullQueueService } from '@@core/@core-services/queues/shared.service';
import { IBaseSync } from '@@core/utils/types/interface';
import { IngestDataService } from '@@core/@core-services/unification/ingest-data.service';
import { CoreUnification } from '@@core/@core-services/unification/core-unification.service';

@Injectable()
export class SyncService implements OnModuleInit, IBaseSync {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private webhook: WebhookService,
    private fieldMappingService: FieldMappingService,
    private serviceRegistry: ServiceRegistry,
    private coreUnification: CoreUnification,
    private registry: CoreSyncRegistry,
    private bullQueueService: BullQueueService,
    private ingestService: IngestDataService,
  ) {
    this.logger.setContext(SyncService.name);
    this.registry.registerService('filestorage', 'user', this);
  }

  async onModuleInit() {
    try {
      await this.bullQueueService.queueSyncJob(
        'filestorage-sync-users',
        '0 0 * * *',
      );
    } catch (error) {
      throw error;
    }
  }

  @Cron('0 */8 * * *') // every 8 hours
  async syncUsers(user_id?: string) {
    try {
      this.logger.log('Syncing users...');
      const users = user_id
        ? [
            await this.prisma.users.findUnique({
              where: {
                id_user: user_id,
              },
            }),
          ]
        : await this.prisma.users.findMany();
      if (users && users.length > 0) {
        for (const user of users) {
          const projects = await this.prisma.projects.findMany({
            where: {
              id_user: user.id_user,
            },
          });
          for (const project of projects) {
            const id_project = project.id_project;
            const linkedUsers = await this.prisma.linked_users.findMany({
              where: {
                id_project: id_project,
              },
            });
            linkedUsers.map(async (linkedUser) => {
              try {
                const providers = FILESTORAGE_PROVIDERS;
                for (const provider of providers) {
                  try {
                    const connection = await this.prisma.connections.findFirst({
                      where: {
                        id_linked_user: linkedUser.id_linked_user,
                        provider_slug: provider.toLowerCase(),
                      },
                    });
                    const groups = await this.prisma.fs_groups.findMany({
                      where: {
                        id_connection: connection.id_connection,
                      },
                    });
                    for (const group of groups) {
                      await this.syncUsersForLinkedUser(
                        provider,
                        linkedUser.id_linked_user,
                        group.id_fs_group,
                      );
                    }
                    await this.syncUsersForLinkedUser(
                      provider,
                      linkedUser.id_linked_user,
                    );
                  } catch (error) {
                    throw error;
                  }
                }
              } catch (error) {
                throw error;
              }
            });
          }
        }
      }
    } catch (error) {
      throw error;
    }
  }

  async syncUsersForLinkedUser(
    integrationId: string,
    linkedUserId: string,
    group_id?: string,
  ) {
    try {
      this.logger.log(
        `Syncing ${integrationId} users for linkedUser ${linkedUserId}`,
      );
      // check if linkedUser has a connection if not just stop sync
      const connection = await this.prisma.connections.findFirst({
        where: {
          id_linked_user: linkedUserId,
          provider_slug: integrationId,
          vertical: 'filestorage',
        },
      });
      if (!connection) {
        this.logger.warn(
          `Skipping users syncing... No ${integrationId} connection was found for linked user ${linkedUserId} `,
        );
        return;
      }
      // get potential fieldMappings and extract the original properties name
      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'filestorage.user',
        );
      const remoteProperties: string[] = customFieldMappings.map(
        (mapping) => mapping.remote_id,
      );

      const service: IUserService =
        this.serviceRegistry.getService(integrationId);
      if (!service) return;
      const resp: ApiResponse<OriginalUserOutput[]> = await service.syncUsers(
        linkedUserId,
        group_id,
        remoteProperties,
      );
      if (!resp) return;
      const sourceObject: OriginalUserOutput[] = resp.data;

      await this.ingestService.ingestData<
        UnifiedUserOutput,
        OriginalUserOutput
      >(
        sourceObject,
        integrationId,
        connection.id_connection,
        'filestorage',
        'user',
        customFieldMappings,
      );
    } catch (error) {
      throw error;
    }
  }

  async saveToDb(
    connection_id: string,
    linkedUserId: string,
    users: UnifiedUserOutput[],
    originSource: string,
    remote_data: Record<string, any>[],
  ): Promise<FileStorageUser[]> {
    try {
      let users_results: FileStorageUser[] = [];
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const originId = user.remote_id;

        if (!originId || originId === '') {
          throw new ReferenceError(`Origin id not there, found ${originId}`);
        }

        const existingUser = await this.prisma.fs_users.findFirst({
          where: {
            remote_id: originId,
            id_connection: connection_id,
          },
        });

        let unique_fs_user_id: string;

        if (existingUser) {
          // Update the existing user
          let data: any = {
            modified_at: new Date(),
          };
          if (user.name) {
            data = { ...data, name: user.name };
          }
          if (user.email) {
            data = { ...data, email: user.email };
          }
          if (user.is_me) {
            data = { ...data, is_me: user.is_me };
          }
          const res = await this.prisma.fs_users.update({
            where: {
              id_fs_user: existingUser.id_fs_user,
            },
            data: data,
          });
          unique_fs_user_id = res.id_fs_user;
          users_results = [...users_results, res];
        } else {
          // Create a new user
          this.logger.log('User does not exist, creating a new one');
          const uuid = uuidv4();
          let data: any = {
            id_fs_user: uuid,
            created_at: new Date(),
            modified_at: new Date(),
            remote_id: originId,
            id_connection: connection_id,
          };

          if (user.name) {
            data = { ...data, name: user.name };
          }
          if (user.email) {
            data = { ...data, email: user.email };
          }
          if (user.is_me) {
            data = { ...data, is_me: user.is_me };
          }

          const newUser = await this.prisma.fs_users.create({
            data: data,
          });

          unique_fs_user_id = newUser.id_fs_user;
          users_results = [...users_results, newUser];
        }

        // check duplicate or existing values
        if (user.field_mappings && user.field_mappings.length > 0) {
          const entity = await this.prisma.entity.create({
            data: {
              id_entity: uuidv4(),
              ressource_owner_id: unique_fs_user_id,
            },
          });

          for (const [slug, value] of Object.entries(user.field_mappings)) {
            const attribute = await this.prisma.attribute.findFirst({
              where: {
                slug: slug,
                source: originSource,
                id_consumer: linkedUserId,
              },
            });

            if (attribute) {
              await this.prisma.value.create({
                data: {
                  id_value: uuidv4(),
                  data: value || 'null',
                  attribute: {
                    connect: {
                      id_attribute: attribute.id_attribute,
                    },
                  },
                  entity: {
                    connect: {
                      id_entity: entity.id_entity,
                    },
                  },
                },
              });
            }
          }
        }

        // insert remote_data in db
        await this.prisma.remote_data.upsert({
          where: {
            ressource_owner_id: unique_fs_user_id,
          },
          create: {
            id_remote_data: uuidv4(),
            ressource_owner_id: unique_fs_user_id,
            format: 'json',
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
          update: {
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
        });
      }
      return users_results;
    } catch (error) {
      throw error;
    }
  }
}
