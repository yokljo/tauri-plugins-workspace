// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { invoke } from '@tauri-apps/api/core'

export interface QueryResult {
  /** The number of rows affected by the query. */
  rowsAffected: number
  /**
   * The last inserted `id`.
   *
   * This value is not set for Postgres databases. If the
   * last inserted id is required on Postgres, the `select` function
   * must be used, with a `RETURNING` clause
   * (`INSERT INTO todos (title) VALUES ($1) RETURNING id`).
   */
  lastInsertId?: number
}

/**
 * **DatabaseConnection**
 *
 * The `DatabaseConnection` class is returned by calling `acquire()` on a `Database` instance. It
 * represents a persistent database connection from the connection pool, which makes it possible
 * to do transactions.
 * You *must* call `release()` to return the connection to the pool, otherwise you will run out of
 * connections and the database will freeze.
 */
export interface DatabaseConnection {
  release(): Promise<void>

  execute(query: string, bindValues?: unknown[]): Promise<QueryResult>

  select<T>(query: string, bindValues?: unknown[]): Promise<T>
}

/** This is the actual implementation of `DatabaseConnection`. It is not exported so the user must go through a `Database` instance to create a connection. */
class DatabaseConnectionInstance {
  path: string
  id: number
  released: boolean = false

  constructor(path: string, id: number) {
    this.path = path
    this.id = id
  }

  private checkRelease() {
    if (this.released) {
      throw new Error(`DatabaseConnection for ${this.path} has already been released`)
    }
  }

  /** Release the connection back to the connection pool so it can be used by something else. */
  async release() {
    this.checkRelease()

    await invoke<[number]>(
      'plugin:sql|release',
      {
        db: this.path,
        connection_id: this.id,
      }
    )
    
    this.released = true
  }

  /**
   * **execute**
   *
   * Passes a SQL expression to the database connection for execution.
   *
   * @example
   * ```ts
   * // for sqlite & postgres
   * // INSERT example
   * const conn = await db.acquire();
   * try {
   *    const result = await conn.execute(
   *       "INSERT into todos (id, title, status) VALUES ($1, $2, $3)",
   *       [ todos.id, todos.title, todos.status ]
   *    );
   *    // UPDATE example
   *    const result = await conn.execute(
   *       "UPDATE todos SET title = $1, completed = $2 WHERE id = $3",
   *       [ todos.title, todos.status, todos.id ]
   *    );
   *
   *    // for mysql
   *    // INSERT example
   *    const result = await conn.execute(
   *       "INSERT into todos (id, title, status) VALUES (?, ?, ?)",
   *       [ todos.id, todos.title, todos.status ]
   *    );
   *    // UPDATE example
   *    const result = await conn.execute(
   *       "UPDATE todos SET title = ?, completed = ? WHERE id = ?",
   *       [ todos.title, todos.status, todos.id ]
   *    );
   * } finally {
   *    await conn.release();
   * }
   * ```
   */
  async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    this.checkRelease()

    const [rowsAffected, lastInsertId] = await invoke<[number, number]>(
      'plugin:sql|execute',
      {
        db: this.path,
        connection_id: this.id,
        query,
        values: bindValues ?? []
      }
    )
    return {
      lastInsertId,
      rowsAffected
    }
  }

  /**
   * **select**
   *
   * Passes in a SELECT query to the database connection for execution.
   *
   * @example
   * ```ts
   * const conn = await db.acquire();
   * try {
   *    // for sqlite & postgres
   *    const result = await db.select(
   *       "SELECT * from todos WHERE id = $1", [ id ]
   *    );
   *
   *    // for mysql
   *    const result = await db.select(
   *       "SELECT * from todos WHERE id = ?", [ id ]
   *    );
   * } finally {
   *    await conn.release();
   * }
   * ```
   */
  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    this.checkRelease()

    const result = await invoke<T>('plugin:sql|select', {
      db: this.path,
      connection_id: this.id,
      query,
      values: bindValues ?? []
    })

    return result
  }
}

/**
 * **Database**
 *
 * The `Database` class serves as the primary interface for
 * communicating with the rust side of the sql plugin.
 */
export default class Database {
  path: string
  constructor(path: string) {
    this.path = path
  }

  /**
   * **load**
   *
   * A static initializer which connects to the underlying database and
   * returns a `Database` instance once a connection to the database is established.
   *
   * # Sqlite
   *
   * The path is relative to `tauri::path::BaseDirectory::App` and must start with `sqlite:`.
   *
   * @example
   * ```ts
   * const db = await Database.load("sqlite:test.db");
   * ```
   */
  static async load(path: string): Promise<Database> {
    const _path = await invoke<string>('plugin:sql|load', {
      db: path
    })

    return new Database(_path)
  }

  /**
   * **get**
   *
   * A static initializer which synchronously returns an instance of
   * the Database class while deferring the actual database connection
   * until the first invocation or selection on the database.
   *
   * # Sqlite
   *
   * The path is relative to `tauri::path::BaseDirectory::App` and must start with `sqlite:`.
   *
   * @example
   * ```ts
   * const db = Database.get("sqlite:test.db");
   * ```
   */
  static get(path: string): Database {
    return new Database(path)
  }

  /**
   * **acquire**
   *
   * Acquires a persistent database connection from the connection pool, which makes it possible
   * to do transactions.
   * You *must* call `release()` on the `DatabaseConnection` object to return the connection to the
   * pool, otherwise you will run out of connections and the database will freeze.
   */
  async acquire(): Promise<DatabaseConnection> {
    const [connectionId] = await invoke<[number]>(
      'plugin:sql|acquire',
      {
        db: this.path,
      }
    )
    return new DatabaseConnectionInstance(this.path, connectionId)
  }

  /**
   * **execute**
   *
   * Passes a SQL expression to the database for execution.
   *
   * @example
   * ```ts
   * // for sqlite & postgres
   * // INSERT example
   * const result = await db.execute(
   *    "INSERT into todos (id, title, status) VALUES ($1, $2, $3)",
   *    [ todos.id, todos.title, todos.status ]
   * );
   * // UPDATE example
   * const result = await db.execute(
   *    "UPDATE todos SET title = $1, completed = $2 WHERE id = $3",
   *    [ todos.title, todos.status, todos.id ]
   * );
   *
   * // for mysql
   * // INSERT example
   * const result = await db.execute(
   *    "INSERT into todos (id, title, status) VALUES (?, ?, ?)",
   *    [ todos.id, todos.title, todos.status ]
   * );
   * // UPDATE example
   * const result = await db.execute(
   *    "UPDATE todos SET title = ?, completed = ? WHERE id = ?",
   *    [ todos.title, todos.status, todos.id ]
   * );
   * ```
   */
  async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    const conn = await this.acquire()
    try {
      return await conn.execute(query, bindValues)
    } finally {
      await conn.release()
    }
  }

  /**
   * **select**
   *
   * Passes in a SELECT query to the database for execution.
   *
   * @example
   * ```ts
   * // for sqlite & postgres
   * const result = await db.select(
   *    "SELECT * from todos WHERE id = $1", [ id ]
   * );
   *
   * // for mysql
   * const result = await db.select(
   *    "SELECT * from todos WHERE id = ?", [ id ]
   * );
   * ```
   */
  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    const conn = await this.acquire()
    try {
      return await conn.select(query, bindValues)
    } finally {
      await conn.release()
    }
  }

  /**
   * **close**
   *
   * Closes the database connection pool.
   *
   * @example
   * ```ts
   * const success = await db.close()
   * ```
   * @param db - Optionally state the name of a database if you are managing more than one. Otherwise, all database pools will be in scope.
   */
  async close(db?: string): Promise<boolean> {
    const success = await invoke<boolean>('plugin:sql|close', {
      db
    })
    return success
  }
}
