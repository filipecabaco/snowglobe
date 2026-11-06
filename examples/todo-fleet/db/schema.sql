CREATE TABLE todos (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  inserted_at timestamp(0) NOT NULL DEFAULT now(),
  updated_at timestamp(0) NOT NULL DEFAULT now()
);
INSERT INTO todos (title) VALUES ('Try the todo fleet'), ('Add a todo of your own');
