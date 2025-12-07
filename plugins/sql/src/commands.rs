// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::migrate::Migrator;
use tauri::{command, AppHandle, Runtime, State};

use crate::{DbInstances, DbPool, Error, LastInsertId, Migrations};

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    db_instances: State<'_, DbInstances>,
    migrations: State<'_, Migrations>,
    db: String,
) -> Result<String, crate::Error> {
    let pool = DbPool::connect(&db, &app).await?;

    if let Some(migrations) = migrations.0.lock().await.remove(&db) {
        let migrator = Migrator::new(migrations).await?;
        pool.migrate(&migrator).await?;
    }

    db_instances.0.write().await.insert(db.clone(), crate::DbPoolManager::new(pool));

    Ok(db)
}

/// Allows the database connection(s) to be closed; if no database
/// name is passed in then _all_ database connection pools will be
/// shut down.
#[command]
pub(crate) async fn close(
    db_instances: State<'_, DbInstances>,
    db: Option<String>,
) -> Result<bool, crate::Error> {
    let mut instances = db_instances.0.write().await;

    let pools = if let Some(db) = db {
        vec![db]
    } else {
        instances.keys().cloned().collect()
    };

    for pool in pools {
        let db = instances.get_mut(&pool).ok_or(Error::DatabaseNotLoaded(pool))?;
        db.connections.clear();
        db.pool.close().await;
    }

    Ok(true)
}

/// Acquires a persistent database connection from the connection pool, which makes it possible to
/// do transactions. This command returns a unique number which can be passed a execute/select to
/// make a query on the acquired connection. Invoke the `release` command with the connection ID to
/// return the connection to the pool.
#[command]
pub(crate) async fn acquire(
    db_instances: State<'_, DbInstances>,
    db: String,
) -> Result<i64, crate::Error> {
    let mut instances = db_instances.0.write().await;

    let db_instance = instances.get_mut(&db).ok_or(Error::DatabaseNotLoaded(db.clone()))?;
    let connection = db_instance.pool.acquire().await?;
    
    let connection_id = db_instance.next_connection_id;
    db_instance.next_connection_id += 1;
    db_instance.connections.insert(connection_id, connection);

    Ok(connection_id)
}

/// Releases a persistent database connection (acquired by the `acquire` command) to the connection
/// pool.
#[command]
pub(crate) async fn release(
    db_instances: State<'_, DbInstances>,
    db: String,
    connection_id: i64,
) -> Result<(), crate::Error> {
    let mut instances = db_instances.0.write().await;

    let db_instance = instances.get_mut(&db).ok_or(Error::DatabaseNotLoaded(db.clone()))?;

    db_instance.connections.remove(&connection_id)
        .ok_or(Error::NoSuchPoolConnection(db, connection_id))?;

    Ok(())
}

/// Execute a command against the database
#[command]
pub(crate) async fn execute(
    db_instances: State<'_, DbInstances>,
    db: String,
    connection_id: Option<i64>,
    query: String,
    values: Vec<JsonValue>,
) -> Result<(u64, LastInsertId), crate::Error> {
    let instances = db_instances.0.read().await;

    let db_instance = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db.clone()))?;
    if let Some(connection_id) = connection_id {
        let conn = db_instance.connections.get(&connection_id)
            .ok_or(crate::Error::NoSuchPoolConnection(db, connection_id))?;

        conn.execute(query, values).await
    } else {
        // The connection returned by acquire is returned to the pool when conn is dropped.
        let conn = db_instance.pool.acquire().await?;
        conn.execute(query, values).await
    }
}

#[command]
pub(crate) async fn select(
    db_instances: State<'_, DbInstances>,
    db: String,
    connection_id: Option<i64>,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
    let instances = db_instances.0.read().await;

    let db_instance = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db.clone()))?;
    if let Some(connection_id) = connection_id {
        let conn = db_instance.connections.get(&connection_id)
            .ok_or(crate::Error::NoSuchPoolConnection(db, connection_id))?;

        conn.select(query, values).await
    } else {
        // The connection returned by acquire is returned to the pool when conn is dropped.
        let conn = db_instance.pool.acquire().await?;
        conn.select(query, values).await
    }
}
