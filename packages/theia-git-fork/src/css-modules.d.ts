// *****************************************************************************
// Fork addition (not present upstream): ambient module declarations so that the
// side-effect CSS imports in the browser frontend modules type-check under a
// plain `tsc` build (upstream builds via @theia/ext-scripts / webpack which
// resolve these at bundle time). See FORK.md.
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

declare module '*.css';
