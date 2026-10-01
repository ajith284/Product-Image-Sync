// Generated from the Supabase schema (project xkzccfxrixpyozfhamdh).
// Regenerate after every migration:
//   npx supabase gen types typescript --project-id xkzccfxrixpyozfhamdh > lib/supabase/database.types.ts
// Server-only tables in the `internal` schema are intentionally not exposed or typed here.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          created_at: string
          event_type: string
          id: string
          message: string
          metadata: Json
          store_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          message: string
          metadata?: Json
          store_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          message?: string
          metadata?: Json
          store_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_store_fkey"
            columns: ["store_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "activity_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      google_drive_connections: {
        Row: {
          connected_at: string | null
          connected_by: string | null
          connection_status: string
          created_at: string
          disconnected_at: string | null
          google_account_email: string | null
          google_account_id: string | null
          granted_scopes: Json
          id: string
          last_error: string | null
          last_verified_at: string | null
          root_folder_id: string | null
          root_folder_name: string | null
          store_id: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          connected_at?: string | null
          connected_by?: string | null
          connection_status?: string
          created_at?: string
          disconnected_at?: string | null
          google_account_email?: string | null
          google_account_id?: string | null
          granted_scopes?: Json
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          root_folder_id?: string | null
          root_folder_name?: string | null
          store_id: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          connected_at?: string | null
          connected_by?: string | null
          connection_status?: string
          created_at?: string
          disconnected_at?: string | null
          google_account_email?: string | null
          google_account_id?: string | null
          granted_scopes?: Json
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          root_folder_id?: string | null
          root_folder_name?: string | null
          store_id?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_drive_connections_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      product_mappings: {
        Row: {
          created_at: string
          created_by: string | null
          drive_folder_id: string
          drive_folder_name: string | null
          id: string
          mapping_type: string
          shopify_product_id: string
          shopify_product_title: string | null
          store_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          drive_folder_id: string
          drive_folder_name?: string | null
          id?: string
          mapping_type?: string
          shopify_product_id: string
          shopify_product_title?: string | null
          store_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          drive_folder_id?: string
          drive_folder_name?: string | null
          id?: string
          mapping_type?: string
          shopify_product_id?: string
          shopify_product_title?: string | null
          store_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_mappings_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      shopify_connections: {
        Row: {
          connected_by: string | null
          disconnected_at: string | null
          last_error: string | null
          refresh_token_expires_at: string | null
          connection_status: string
          created_at: string
          granted_scopes: Json
          id: string
          installed_at: string | null
          last_verified_at: string | null
          shop_domain: string | null
          shopify_shop_id: string | null
          store_id: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          connected_by?: string | null
          disconnected_at?: string | null
          last_error?: string | null
          refresh_token_expires_at?: string | null
          connection_status?: string
          created_at?: string
          granted_scopes?: Json
          id?: string
          installed_at?: string | null
          last_verified_at?: string | null
          shop_domain?: string | null
          shopify_shop_id?: string | null
          store_id: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          connected_by?: string | null
          disconnected_at?: string | null
          last_error?: string | null
          refresh_token_expires_at?: string | null
          connection_status?: string
          created_at?: string
          granted_scopes?: Json
          id?: string
          installed_at?: string | null
          last_verified_at?: string | null
          shop_domain?: string | null
          shopify_shop_id?: string | null
          store_id?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopify_connections_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      store_settings: {
        Row: {
          allowed_image_types: string[]
          auto_sync_enabled: boolean
          case_insensitive: boolean
          created_at: string
          id: string
          ignored_folders: string[]
          matching_mode: string
          store_id: string
          sync_schedule: string | null
          trim_spaces: boolean
          updated_at: string
        }
        Insert: {
          allowed_image_types?: string[]
          auto_sync_enabled?: boolean
          case_insensitive?: boolean
          created_at?: string
          id?: string
          ignored_folders?: string[]
          matching_mode?: string
          store_id: string
          sync_schedule?: string | null
          trim_spaces?: boolean
          updated_at?: string
        }
        Update: {
          allowed_image_types?: string[]
          auto_sync_enabled?: boolean
          case_insensitive?: boolean
          created_at?: string
          id?: string
          ignored_folders?: string[]
          matching_mode?: string
          store_id?: string
          sync_schedule?: string | null
          trim_spaces?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_settings_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: true
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          created_at: string
          id: string
          name: string
          shopify_domain: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          shopify_domain?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          shopify_domain?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_errors: {
        Row: {
          created_at: string
          error_type: string
          id: string
          message: string
          resolved: boolean
          resolved_at: string | null
          store_id: string
          sync_item_id: string | null
          sync_job_id: string | null
        }
        Insert: {
          created_at?: string
          error_type: string
          id?: string
          message: string
          resolved?: boolean
          resolved_at?: string | null
          store_id: string
          sync_item_id?: string | null
          sync_job_id?: string | null
        }
        Update: {
          created_at?: string
          error_type?: string
          id?: string
          message?: string
          resolved?: boolean
          resolved_at?: string | null
          store_id?: string
          sync_item_id?: string | null
          sync_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_errors_item_fkey"
            columns: ["sync_item_id", "store_id"]
            isOneToOne: false
            referencedRelation: "sync_items"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "sync_errors_job_fkey"
            columns: ["sync_job_id", "store_id"]
            isOneToOne: false
            referencedRelation: "sync_jobs"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "sync_errors_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_images: {
        Row: {
          checksum: string | null
          created_at: string
          drive_file_id: string
          drive_modified_at: string | null
          filename: string
          id: string
          shopify_media_id: string | null
          shopify_product_id: string
          store_id: string
          sync_item_id: string | null
          updated_at: string
          upload_status: string
          uploaded_at: string | null
        }
        Insert: {
          checksum?: string | null
          created_at?: string
          drive_file_id: string
          drive_modified_at?: string | null
          filename: string
          id?: string
          shopify_media_id?: string | null
          shopify_product_id: string
          store_id: string
          sync_item_id?: string | null
          updated_at?: string
          upload_status?: string
          uploaded_at?: string | null
        }
        Update: {
          checksum?: string | null
          created_at?: string
          drive_file_id?: string
          drive_modified_at?: string | null
          filename?: string
          id?: string
          shopify_media_id?: string | null
          shopify_product_id?: string
          store_id?: string
          sync_item_id?: string | null
          updated_at?: string
          upload_status?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_images_item_fkey"
            columns: ["sync_item_id", "store_id"]
            isOneToOne: false
            referencedRelation: "sync_items"
            referencedColumns: ["id", "store_id"]
          },
          {
            foreignKeyName: "sync_images_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_items: {
        Row: {
          created_at: string
          drive_folder_id: string
          drive_folder_name: string | null
          error_message: string | null
          id: string
          images_found: number
          images_uploaded: number
          product_status: string | null
          shopify_product_id: string | null
          shopify_product_title: string | null
          status: string
          store_id: string
          sync_job_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          drive_folder_id: string
          drive_folder_name?: string | null
          error_message?: string | null
          id?: string
          images_found?: number
          images_uploaded?: number
          product_status?: string | null
          shopify_product_id?: string | null
          shopify_product_title?: string | null
          status?: string
          store_id: string
          sync_job_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          drive_folder_id?: string
          drive_folder_name?: string | null
          error_message?: string | null
          id?: string
          images_found?: number
          images_uploaded?: number
          product_status?: string | null
          shopify_product_id?: string | null
          shopify_product_title?: string | null
          status?: string
          store_id?: string
          sync_job_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_items_job_fkey"
            columns: ["sync_job_id", "store_id"]
            isOneToOne: false
            referencedRelation: "sync_jobs"
            referencedColumns: ["id", "store_id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          cancel_requested_at: string | null
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          dry_run: boolean
          error_code: string | null
          error_message: string | null
          errors_count: number
          id: string
          idempotency_key: string | null
          images_uploaded: number
          items_failed: number
          items_review: number
          items_skipped: number
          items_total: number
          options: Json
          products_processed: number
          products_synced: number
          request_hash: string | null
          request_id: string | null
          requested_by_api_key: string | null
          requested_by_user: string | null
          started_at: string | null
          status: string
          store_id: string
          trigger_type: string
          warnings_count: number
          workspace_id: string
        }
        Insert: {
          cancel_requested_at?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          dry_run?: boolean
          error_code?: string | null
          error_message?: string | null
          errors_count?: number
          id?: string
          idempotency_key?: string | null
          images_uploaded?: number
          items_failed?: number
          items_review?: number
          items_skipped?: number
          items_total?: number
          options?: Json
          products_processed?: number
          products_synced?: number
          request_hash?: string | null
          request_id?: string | null
          requested_by_api_key?: string | null
          requested_by_user?: string | null
          started_at?: string | null
          status?: string
          store_id: string
          trigger_type?: string
          warnings_count?: number
          workspace_id?: string
        }
        Update: {
          cancel_requested_at?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          dry_run?: boolean
          error_code?: string | null
          error_message?: string | null
          errors_count?: number
          id?: string
          idempotency_key?: string | null
          images_uploaded?: number
          items_failed?: number
          items_review?: number
          items_skipped?: number
          items_total?: number
          options?: Json
          products_processed?: number
          products_synced?: number
          request_hash?: string | null
          request_id?: string | null
          requested_by_api_key?: string | null
          requested_by_user?: string | null
          started_at?: string | null
          status?: string
          store_id?: string
          trigger_type?: string
          warnings_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_store_workspace_fkey"
            columns: ["store_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "sync_jobs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          slug?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          slug?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      api_key_create: {
        Args: {
          p_expires_at: string
          p_key_prefix: string
          p_name: string
          p_scopes: string[]
          p_secret_hash: string
          p_store_id: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      api_key_revoke: {
        Args: { p_key_id: string; p_user_id: string }
        Returns: boolean
      }
      api_keys_list: {
        Args: { p_user_id: string; p_workspace_id: string }
        Returns: {
          created_at: string
          expires_at: string
          id: string
          key_prefix: string
          last_used_at: string
          name: string
          revoked_at: string
          scopes: string[]
          store_id: string
          store_name: string
        }[]
      }
      create_workspace: {
        Args: { p_name: string; p_slug?: string }
        Returns: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          slug: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workspaces"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      // Service-role-only RPCs (migration 20260930110157_shopify_oauth). Nullable args hand-annotated.
      google_begin_oauth: {
        Args: {
          p_state_hash: string
          p_store_id: string
          p_ttl_seconds?: number
          p_user_id: string
        }
        Returns: string
      }
      google_consume_oauth_state: {
        Args: { p_state_hash: string }
        Returns: {
          status: string
          store_id: string
          user_id: string
          workspace_id: string
        }[]
      }
      google_disconnect: {
        Args: { p_store_id: string; p_user_id: string }
        Returns: boolean
      }
      google_get_credentials: {
        Args: { p_store_id: string }
        Returns: {
          account_shared: boolean
          connection_id: string
          connection_status: string
          encrypted_access_token: string
          encrypted_refresh_token: string
          google_account_id: string
          token_expires_at: string
          token_version: number
          workspace_id: string
        }[]
      }
      google_record_verification: {
        Args: {
          p_account_email?: string
          p_error?: string
          p_failure_status?: string
          p_log?: boolean
          p_ok: boolean
          p_store_id: string
        }
        Returns: undefined
      }
      google_save_connection: {
        Args: {
          p_access_expires_at: string
          p_encrypted_access_token: string
          p_encrypted_refresh_token: string
          p_google_account_email: string
          p_google_account_id: string
          p_scopes: string
          p_store_id: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      google_store_refreshed_tokens: {
        Args: {
          p_access_expires_at: string
          p_connection_id: string
          p_encrypted_access_token: string
          p_encrypted_refresh_token: string
          p_expected_version: number
        }
        Returns: boolean
      }
      n8n_authenticate: {
        Args: { p_key_prefix: string }
        Returns: {
          id: string
          name: string
          scopes: string[]
          secret_hash: string
          store_id: string
          workspace_id: string
        }[]
      }
      n8n_cancel_sync_job: {
        Args: { p_job_id: string; p_key_id: string; p_request_id: string }
        Returns: { changed: boolean; job: Json }[]
      }
      n8n_create_sync_job: {
        Args: {
          p_dry_run: boolean
          p_idempotency_key: string
          p_key_id: string
          p_options: Json
          p_request_hash: string
          p_request_id: string
          p_store_id: string
          p_trigger: string
        }
        Returns: { job: Json; replayed: boolean }[]
      }
      n8n_get_sync_job: {
        Args: { p_job_id: string; p_key_id: string }
        Returns: Json
      }
      n8n_list_sync_jobs: {
        Args: {
          p_cursor_created_at?: string
          p_cursor_id?: string
          p_key_id: string
          p_limit?: number
          p_status?: string
          p_store_id?: string
        }
        Returns: Json[]
      }
      n8n_rate_limit_hit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number }
        Returns: { allowed: boolean; current_count: number; retry_after: number }[]
      }
      n8n_store_status: {
        Args: { p_key_id: string; p_store_id: string }
        Returns: Json
      }
      n8n_touch_api_key: {
        Args: { p_key_id: string }
        Returns: undefined
      }
      n8n_use_nonce: {
        Args: { p_key_id: string; p_nonce: string; p_ttl_seconds?: number }
        Returns: boolean
      }
      shopify_begin_oauth: {
        Args: { p_state_hash: string; p_store_id: string; p_ttl_seconds?: number; p_user_id: string }
        Returns: string
      }
      shopify_consume_oauth_state: {
        Args: { p_state_hash: string }
        Returns: {
          shop_domain: string | null
          status: string
          store_id: string | null
          user_id: string | null
          workspace_id: string | null
        }[]
      }
      shopify_disconnect: {
        Args: { p_store_id: string; p_user_id: string }
        Returns: boolean
      }
      shopify_get_credentials: {
        Args: { p_store_id: string }
        Returns: {
          connection_id: string
          connection_status: string
          encrypted_access_token: string | null
          encrypted_refresh_token: string | null
          refresh_token_expires_at: string | null
          shop_domain: string
          token_expires_at: string | null
          token_version: number
          workspace_id: string
        }[]
      }
      shopify_handle_app_uninstalled: {
        Args: { p_shop_domain: string; p_webhook_id: string }
        Returns: string
      }
      shopify_record_verification: {
        Args: {
          p_error?: string | null
          p_failure_status?: string | null
          p_log?: boolean
          p_ok: boolean
          p_shopify_shop_id?: string | null
          p_store_id: string
        }
        Returns: undefined
      }
      shopify_record_webhook: {
        Args: { p_shop_domain: string | null; p_topic: string; p_webhook_id: string }
        Returns: boolean
      }
      shopify_save_connection: {
        Args: {
          p_access_expires_at: string | null
          p_encrypted_access_token: string
          p_encrypted_refresh_token: string | null
          p_refresh_expires_at: string | null
          p_scopes: string
          p_shop_domain: string
          p_store_id: string
          p_user_id: string
          p_workspace_id: string
        }
        Returns: string
      }
      shopify_store_refreshed_tokens: {
        Args: {
          p_access_expires_at: string | null
          p_connection_id: string
          p_encrypted_access_token: string
          p_encrypted_refresh_token: string | null
          p_expected_version: number
          p_refresh_expires_at: string | null
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]
