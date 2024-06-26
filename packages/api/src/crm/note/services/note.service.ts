import { LoggerService } from '@@core/@core-services/logger/logger.service';
import { PrismaService } from '@@core/@core-services/prisma/prisma.service';
import { WebhookService } from '@@core/@core-services/webhooks/panora-webhooks/webhook.service';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { ApiResponse } from '@@core/utils/types';
import { OriginalNoteOutput } from '@@core/utils/types/original/original.crm';
import { CrmObject } from '@crm/@lib/@types';
import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { INoteService } from '../types';
import { UnifiedNoteInput, UnifiedNoteOutput } from '../types/model.unified';
import { ServiceRegistry } from './registry.service';
import { CoreUnification } from '@@core/@core-services/unification/core-unification.service';

@Injectable()
export class NoteService {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private webhook: WebhookService,
    private fieldMappingService: FieldMappingService,
    private serviceRegistry: ServiceRegistry,
    private coreUnification: CoreUnification,
  ) {
    this.logger.setContext(NoteService.name);
  }

  async addNote(
    unifiedNoteData: UnifiedNoteInput,
    connection_id: string,
    integrationId: string,
    linkedUserId: string,
    remote_data?: boolean,
  ): Promise<UnifiedNoteOutput> {
    try {
      const linkedUser = await this.prisma.linked_users.findUnique({
        where: {
          id_linked_user: linkedUserId,
        },
      });

      //CHECKS
      if (!linkedUser) throw new ReferenceError('Linked User Not Found');

      const user = unifiedNoteData.user_id;
      if (user) {
        const search = await this.prisma.crm_users.findUnique({
          where: {
            id_crm_user: user,
          },
        });
        if (!search)
          throw new ReferenceError(
            'You inserted a user_id which does not exist',
          );
      }

      const company = unifiedNoteData.company_id;
      //check if contact_id and account_id refer to real uuids
      if (company) {
        const search = await this.prisma.crm_companies.findUnique({
          where: {
            id_crm_company: company,
          },
        });
        if (!search)
          throw new ReferenceError(
            'You inserted a company_id which does not exist',
          );
      }
      const contact = unifiedNoteData.contact_id;
      //check if contact_id and account_id refer to real uuids
      if (contact) {
        const search = await this.prisma.crm_contacts.findUnique({
          where: {
            id_crm_contact: contact,
          },
        });
        if (!search)
          throw new ReferenceError(
            'You inserted a contact_id which does not exist',
          );
      }

      const deal = unifiedNoteData.deal_id;
      //check if contact_id and account_id refer to real uuids
      if (deal) {
        const search = await this.prisma.crm_deals.findUnique({
          where: {
            id_crm_deal: deal,
          },
        });
        if (!search)
          throw new ReferenceError(
            'You inserted a deal_id which does not exist',
          );
      }

      //desunify the data according to the target obj wanted
      const desunifiedObject =
        await this.coreUnification.desunify<UnifiedNoteInput>({
          sourceObject: unifiedNoteData,
          targetType: CrmObject.note,
          providerName: integrationId,
          vertical: 'crm',
          customFieldMappings: [],
        });

      const service: INoteService =
        this.serviceRegistry.getService(integrationId);

      const resp: ApiResponse<OriginalNoteOutput> = await service.addNote(
        desunifiedObject,
        linkedUserId,
      );

      //unify the data according to the target obj wanted
      const unifiedObject = (await this.coreUnification.unify<
        OriginalNoteOutput[]
      >({
        sourceObject: [resp.data],
        targetType: CrmObject.note,
        providerName: integrationId,
        vertical: 'crm',
        connectionId: connection_id,
        customFieldMappings: [],
      })) as UnifiedNoteOutput[];

      // add the note inside our db
      const source_note = resp.data;
      const target_note = unifiedObject[0];

      const existingNote = await this.prisma.crm_notes.findFirst({
        where: {
          remote_id: target_note.remote_id,
          id_connection: connection_id,
        },
      });

      let unique_crm_note_id: string;

      if (existingNote) {
        // Update the existing note
        let data: any = {
          modified_at: new Date(),
        };
        if (target_note.content) {
          data = { ...data, content: target_note.content };
        }
        if (target_note.contact_id) {
          data = { ...data, id_crm_contact: target_note.contact_id };
        }
        if (target_note.company_id) {
          data = { ...data, id_crm_company: target_note.company_id };
        }
        if (target_note.deal_id) {
          data = { ...data, id_crm_deal: target_note.deal_id };
        }
        if (target_note.user_id) {
          data = { ...data, id_crm_user: target_note.user_id };
        }

        const res = await this.prisma.crm_notes.update({
          where: {
            id_crm_note: existingNote.id_crm_note,
          },
          data: data,
        });
        unique_crm_note_id = res.id_crm_note;
      } else {
        // Create a new note
        this.logger.log('note not exists');
        let data: any = {
          id_crm_note: uuidv4(),
          created_at: new Date(),
          modified_at: new Date(),
          remote_id: target_note.remote_id,
          id_connection: connection_id,
        };
        if (target_note.content) {
          data = { ...data, content: target_note.content };
        }
        if (target_note.contact_id) {
          data = { ...data, id_crm_contact: target_note.contact_id };
        }
        if (target_note.company_id) {
          data = { ...data, id_crm_company: target_note.company_id };
        }
        if (target_note.deal_id) {
          data = { ...data, id_crm_deal: target_note.deal_id };
        }

        if (target_note.user_id) {
          data = { ...data, id_crm_user: target_note.user_id };
        }

        const res = await this.prisma.crm_notes.create({
          data: data,
        });
        unique_crm_note_id = res.id_crm_note;
      }

      //insert remote_data in db
      await this.prisma.remote_data.upsert({
        where: {
          ressource_owner_id: unique_crm_note_id,
        },
        create: {
          id_remote_data: uuidv4(),
          ressource_owner_id: unique_crm_note_id,
          format: 'json',
          data: JSON.stringify(source_note),
          created_at: new Date(),
        },
        update: {
          data: JSON.stringify(source_note),
          created_at: new Date(),
        },
      });

      const result_note = await this.getNote(
        unique_crm_note_id,
        undefined,
        undefined,
        remote_data,
      );

      const status_resp = resp.statusCode === 201 ? 'success' : 'fail';

      const event = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: status_resp,
          type: 'crm.note.push', //sync, push or pull
          method: 'POST',
          url: '/crm/notes',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      await this.webhook.dispatchWebhook(
        result_note,
        'crm.note.created',
        linkedUser.id_project,
        event.id_event,
      );
      return result_note;
    } catch (error) {
      throw error;
    }
  }

  async getNote(
    id_note: string,
    linkedUserId: string,
    integrationId: string,
    remote_data?: boolean,
  ): Promise<UnifiedNoteOutput> {
    try {
      const note = await this.prisma.crm_notes.findUnique({
        where: {
          id_crm_note: id_note,
        },
      });

      // Fetch field mappings for the note
      const values = await this.prisma.value.findMany({
        where: {
          entity: {
            ressource_owner_id: note.id_crm_note,
          },
        },
        include: {
          attribute: true,
        },
      });

      const fieldMappingsMap = new Map();

      values.forEach((value) => {
        fieldMappingsMap.set(value.attribute.slug, value.data);
      });

      // Convert the map to an array of objects
      const field_mappings = Array.from(fieldMappingsMap, ([key, value]) => ({
        [key]: value,
      }));

      // Transform to UnifiedNoteOutput format
      const unifiedNote: UnifiedNoteOutput = {
        id: note.id_crm_note,
        content: note.content,
        company_id: note.id_crm_company,
        contact_id: note.id_crm_contact, // uuid of Contact object
        deal_id: note.id_crm_deal, // uuid of Contact object
        user_id: note.id_crm_user,
        field_mappings: field_mappings,
        remote_id: note.remote_id,
        created_at: note.created_at,
        modified_at: note.modified_at,
      };

      let res: UnifiedNoteOutput = {
        ...unifiedNote,
      };

      if (remote_data) {
        const resp = await this.prisma.remote_data.findFirst({
          where: {
            ressource_owner_id: note.id_crm_note,
          },
        });
        const remote_data = JSON.parse(resp.data);

        res = {
          ...res,
          remote_data: remote_data,
        };
      }
      if (linkedUserId && integrationId) {
        await this.prisma.events.create({
          data: {
            id_event: uuidv4(),
            status: 'success',
            type: 'crm.note.pull',
            method: 'GET',
            url: '/crm/note',
            provider: integrationId,
            direction: '0',
            timestamp: new Date(),
            id_linked_user: linkedUserId,
          },
        });
      }
      return res;
    } catch (error) {
      throw error;
    }
  }

  async getNotes(
    connection_id: string,
    integrationId: string,
    linkedUserId: string,
    limit: number,
    remote_data?: boolean,
    cursor?: string,
  ): Promise<{
    data: UnifiedNoteOutput[];
    prev_cursor: null | string;
    next_cursor: null | string;
  }> {
    try {
      let prev_cursor = null;
      let next_cursor = null;

      if (cursor) {
        const isCursorPresent = await this.prisma.crm_notes.findFirst({
          where: {
            id_connection: connection_id,
            id_crm_note: cursor,
          },
        });
        if (!isCursorPresent) {
          throw new ReferenceError(`The provided cursor does not exist!`);
        }
      }

      const notes = await this.prisma.crm_notes.findMany({
        take: limit + 1,
        cursor: cursor
          ? {
              id_crm_note: cursor,
            }
          : undefined,
        orderBy: {
          created_at: 'asc',
        },
        where: {
          id_connection: connection_id,
        },
      });

      if (notes.length === limit + 1) {
        next_cursor = Buffer.from(notes[notes.length - 1].id_crm_note).toString(
          'base64',
        );
        notes.pop();
      }

      if (cursor) {
        prev_cursor = Buffer.from(cursor).toString('base64');
      }

      const unifiedNotes: UnifiedNoteOutput[] = await Promise.all(
        notes.map(async (note) => {
          // Fetch field mappings for the ticket
          const values = await this.prisma.value.findMany({
            where: {
              entity: {
                ressource_owner_id: note.id_crm_note,
              },
            },
            include: {
              attribute: true,
            },
          });
          // Create a map to store unique field mappings
          const fieldMappingsMap = new Map();

          values.forEach((value) => {
            fieldMappingsMap.set(value.attribute.slug, value.data);
          });

          // Convert the map to an array of objects
          const field_mappings = Array.from(
            fieldMappingsMap,
            ([key, value]) => ({ [key]: value }),
          );

          // Transform to UnifiedNoteOutput format
          return {
            id: note.id_crm_note,
            content: note.content,
            company_id: note.id_crm_company,
            contact_id: note.id_crm_contact, // uuid of Contact object
            deal_id: note.id_crm_deal, // uuid of Contact object
            user_id: note.id_crm_user,
            field_mappings: field_mappings,
            remote_id: note.remote_id,
            created_at: note.created_at,
            modified_at: note.modified_at,
          };
        }),
      );

      let res: UnifiedNoteOutput[] = unifiedNotes;

      if (remote_data) {
        const remote_array_data: UnifiedNoteOutput[] = await Promise.all(
          res.map(async (note) => {
            const resp = await this.prisma.remote_data.findFirst({
              where: {
                ressource_owner_id: note.id,
              },
            });
            const remote_data = JSON.parse(resp.data);
            return { ...note, remote_data };
          }),
        );
        res = remote_array_data;
      }

      await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: 'success',
          type: 'crm.note.pulled',
          method: 'GET',
          url: '/crm/notes',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });

      return {
        data: res,
        prev_cursor,
        next_cursor,
      };
    } catch (error) {
      throw error;
    }
  }
}
