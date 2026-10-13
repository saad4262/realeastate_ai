import { ImportStart } from '@/components/imports/import-start';

/** Import contacts from a CSV, an Excel file or a Google Sheet (ADR 0029 amendment, "Contacts import"). */
export default function Page() {
  return <ImportStart surface="agent" kind="contacts" />;
}
