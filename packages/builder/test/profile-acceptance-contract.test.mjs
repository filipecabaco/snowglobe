import {test} from 'node:test';import assert from 'node:assert/strict';
import {allowedProfileSql} from './profile-acceptance-contract.mjs';
test('live acceptance approval is limited to the synthetic profiles schema',()=>{
 assert(allowedProfileSql("CREATE TABLE public.profiles(user_id uuid PRIMARY KEY REFERENCES auth.users(id), display_name text NOT NULL DEFAULT ''); ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; CREATE POLICY own_profiles ON public.profiles FOR ALL TO authenticated USING(auth.uid()=user_id) WITH CHECK(auth.uid()=user_id); GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;"));
 for(const sql of ['',';;;',null,'DROP TABLE public.profiles;','CREATE TABLE public.other(id text);','CREATE TABLE public.profiles(id text); DROP TABLE public.profiles;','COPY public.profiles TO PROGRAM \'id\';','CREATE POLICY read_files ON public.profiles USING(pg_read_file(\'/etc/passwd\') IS NOT NULL);','GRANT SELECT ON public.profiles TO anon;','CREATE POLICY leak ON public.profiles USING(EXISTS(SELECT 1 FROM public.secrets));'])assert.equal(allowedProfileSql(sql),false,String(sql));
});
