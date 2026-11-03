# ERD model format

`erd.mjs` turns every schema source into this one JSON shape, and a `json:` source must already be in it. Write it by hand (or as an agent reading ORM code) when no Prisma schema, SQL dump or SQL migrations folder exists, then run `erd.mjs validate-model <file>` and fix every problem it lists.

```json
{
  "models": [
    {
      "name": "users",
      "table": "users",
      "doc": "People who can sign in.",
      "fields": [
        {
          "name": "id", "column": "id", "type": "bigint", "list": false, "optional": false,
          "default": "nextval('users_id_seq')", "dbType": null, "doc": "",
          "kind": "scalar", "pk": true, "fk": false, "uk": false
        },
        {
          "name": "role", "column": "role", "type": "user_role", "list": false, "optional": false,
          "default": "'member'", "dbType": null, "doc": "",
          "kind": "enum", "pk": false, "fk": false, "uk": false
        }
      ],
      "ids": [],
      "uniques": [],
      "indexes": []
    },
    {
      "name": "posts",
      "table": "posts",
      "doc": "",
      "fields": [
        {
          "name": "id", "column": "id", "type": "bigint", "list": false, "optional": false,
          "default": null, "dbType": null, "doc": "",
          "kind": "scalar", "pk": true, "fk": false, "uk": false
        },
        {
          "name": "author_id", "column": "author_id", "type": "bigint", "list": false, "optional": false,
          "default": null, "dbType": null, "doc": "",
          "kind": "scalar", "pk": false, "fk": true, "uk": false
        }
      ],
      "ids": [],
      "uniques": [],
      "indexes": [["author_id"]]
    }
  ],
  "enums": {
    "user_role": { "doc": "", "values": [{ "name": "admin", "doc": "" }, { "name": "member", "doc": "" }] }
  },
  "relations": [
    {
      "child": "posts", "parent": "users", "field": "author_id",
      "fields": ["author_id"], "references": ["id"],
      "optional": false, "oneToOne": false, "name": "posts_author_id_fkey", "onDelete": "Cascade"
    }
  ]
}
```

## Models

- `name`: the table's display name, unique, without `.`, `/` or `#`. Use the table name; for a schema other than `public`, use `schema:table`.
- `table`: the database table name.
- `doc`: the table's comment or doc string, or `""`.
- `ids`: the columns of a composite primary key; `[]` when the key is one column (mark that field `pk`).
- `uniques`, `indexes`: lists of column-name lists.

## Fields

- `name`: the field name shown; `column`: its database column name.
- `type`: a short type such as `text`, `varchar(255)`, `timestamptz`, or an enum name.
- `list`: true for an array column; `optional`: true when the column is nullable.
- `default`: the default expression as text, or `null`; `dbType`: a native type annotation, or `null`.
- `kind`: `scalar`, `enum` (then `type` must be a key of `enums`) or `relation` (a Prisma-style virtual field with no column, which the diagram does not list as a column).
- `pk`, `fk`, `uk`: part of the primary key, part of a foreign key, has its own single-column unique constraint.

## Relations

One entry per foreign key. `child` holds the key and `parent` is the table it points at; both are model names. `fields` are columns of the child and `references` are columns of the parent, in the same order. `field` is the child column (or the constraint name for a composite key). `optional` is true when any key column is nullable, and `oneToOne` is true when the key columns are also unique in the child. `onDelete` is one of `Cascade`, `Restrict`, `NoAction`, `SetNull`, `SetDefault`, or `null`.

## Excluded tables

SQL sources leave out migration bookkeeping tables by default: `_prisma_migrations`, `schema_migrations`, `ar_internal_metadata`, `knex_migrations`, `knex_migrations_lock`, `__drizzle_migrations`, `flyway_schema_history`, `goose_db_version`, `typeorm_migrations`, `_sqlx_migrations`, `django_migrations`, `alembic_version`, `__EFMigrationsHistory`, `schema_version` and `spatial_ref_sys`. A hand-written model should leave them out too.
