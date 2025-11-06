export interface Database {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          description: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          description?: string | null;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
      };
      source_images: {
        Row: {
          id: string;
          project_id: string;
          user_id: string;
          storage_path: string;
          original_filename: string | null;
          width: number | null;
          height: number | null;
          format: string | null;
          captured_at: string | null;
          metadata: Record<string, unknown> | null;
          created_at: string;
          updated_at: string;
        };
      };
      processed_images: {
        Row: {
          id: string;
          project_id: string;
          user_id: string;
          source_image_id: string;
          storage_path: string;
          variant: string;
          params: Record<string, unknown> | null;
          created_at: string;
          updated_at: string;
        };
      };
      yomitoku_results: {
        Row: {
          id: string;
          project_id: string;
          user_id: string;
          source_image_id: string;
          processed_image_id: string | null;
          summary: string | null;
          result: Record<string, unknown>;
          confidence: number | null;
          created_at: string;
          updated_at: string;
        };
      };
      yomitoku_result_fields: {
        Row: {
          id: number;
          result_id: string;
          project_id: string;
          user_id: string;
          key_path: string;
          value_text: string | null;
          value_numeric: number | null;
          value_boolean: boolean | null;
          value_json: Record<string, unknown> | null;
          created_at: string;
        };
      };
    };
  };
}

export type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
export type SourceImageRow = Database["public"]["Tables"]["source_images"]["Row"];
export type ProcessedImageRow = Database["public"]["Tables"]["processed_images"]["Row"];
export type YomitokuResultRow = Database["public"]["Tables"]["yomitoku_results"]["Row"];
export type ResultFieldRow = Database["public"]["Tables"]["yomitoku_result_fields"]["Row"];
