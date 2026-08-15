insert into storage.buckets (id, name, public)
values ('inventory-uploads', 'inventory-uploads', false)
on conflict (id) do nothing;

create policy "Users can upload inventory files"
on storage.objects for insert to authenticated
with check (bucket_id = 'inventory-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can read inventory files"
on storage.objects for select to authenticated
using (bucket_id = 'inventory-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
